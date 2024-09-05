const jsyaml = require('js-yaml');
const fs = require('fs');
const crypto = require('crypto');

let optionHashes = {
    RouteOption: {},
    VirtualHostOption: {}
};

let additionalObjects = [];

function convertVirtualServiceToHttpRoute(vs) {
    const httpRoute = {
        apiVersion: 'gateway.networking.k8s.io/v1beta1',
        kind: 'HTTPRoute',
        metadata: {
            name: vs.metadata.name,
            namespace: vs.metadata.namespace
        },
        spec: {
            hostnames: vs.spec.virtualHost.domains,
            rules: vs.spec.virtualHost.routes.map(route => convertRoute(route, vs.metadata.namespace))
        }
    };

    if (vs.spec.virtualHost.options) {
        applyOptions(httpRoute, vs.spec.virtualHost.options, vs.metadata.namespace);
    }

    return jsyaml.dump(httpRoute);
}

function convertRouteTableToHttpRoute(rt) {
    const httpRoute = {
        apiVersion: 'gateway.networking.k8s.io/v1beta1',
        kind: 'HTTPRoute',
        metadata: {
            name: rt.metadata.name,
            namespace: rt.metadata.namespace
        },
        spec: {
            rules: rt.spec.routes.map(route => convertRoute(route, rt.metadata.namespace))
        }
    };

    if (rt.spec.options) {
        applyOptions(httpRoute, rt.spec.options, rt.metadata.namespace);
    }

    return jsyaml.dump(httpRoute);
}

function convertRoute(route, namespace) {
    let rule = {
        matches: route.matchers.map(convertMatcher)
    };

    if (route.delegateAction) {
        rule.backendRefs = [{
            group: 'gateway.networking.k8s.io',
            kind: 'HTTPRoute',
            name: getDelegateRouteName(route.delegateAction),
            namespace: getDelegateRouteNamespace(route.delegateAction, namespace)
        }];
    } else if (route.routeAction && route.routeAction.single) {
        rule.backendRefs = [convertDestination(route.routeAction.single)];
    }

    if (route.options) {
        rule.filters = convertOptionsToFilters(route.options);
        const remainingOptions = getUnconvertedOptions(route.options);
        if (Object.keys(remainingOptions).length > 0) {
            const { name } = getOrCreateRouteOption(remainingOptions, namespace);
            rule.filters.push({
                type: 'ExtensionRef',
                extensionRef: {
                    group: 'gateway.solo.io',
                    kind: 'RouteOption',
                    name: name
                }
            });
        }
    }

    return rule;
}

function convertMatcher(matcher) {
    let match = {};

    if (matcher.prefix) {
        match.path = { type: 'PathPrefix', value: matcher.prefix };
    } else if (matcher.exact) {
        match.path = { type: 'Exact', value: matcher.exact };
    } else if (matcher.regex) {
        match.path = { type: 'RegularExpression', value: matcher.regex };
    }

    if (matcher.headers) {
        match.headers = matcher.headers.map(header => ({
            name: header.name,
            type: header.regex ? 'RegularExpression' : 'Exact',
            value: header.value
        }));
    }

    if (matcher.methods) {
        match.method = matcher.methods;
    }

    if (matcher.queryParameters) {
        match.queryParams = matcher.queryParameters.map(param => ({
            name: param.name,
            type: param.regex ? 'RegularExpression' : 'Exact',
            value: param.value
        }));
    }

    return match;
}

function convertDestination(dest) {
    if (dest.upstream) {
        return {
            group: "gloo.solo.io",
            kind: "Upstream",
            name: dest.upstream.name,
            namespace: dest.upstream.namespace
        };
    } else if (dest.kube) {
        return {
            name: dest.kube.ref.name,
            namespace: dest.kube.ref.namespace,
            port: dest.kube.port
        };
    }
}

function applyOptions(httpRoute, options, namespace) {
    const filters = convertOptionsToFilters(options);
    if (filters.length > 0) {
        httpRoute.spec.filters = filters;
    }
    
    const remainingOptions = getUnconvertedOptions(options);
    if (Object.keys(remainingOptions).length > 0) {
        const { name } = getOrCreateVirtualHostOption(remainingOptions, namespace);
        httpRoute.spec.filters = httpRoute.spec.filters || [];
        httpRoute.spec.filters.push({
            type: 'ExtensionRef',
            extensionRef: {
                group: 'gateway.solo.io',
                kind: 'VirtualHostOption',
                name: name
            }
        });
    }
}

function convertOptionsToFilters(options) {
    const filters = [];

    if (options.prefixRewrite) {
        filters.push({
            type: 'URLRewrite',
            urlRewrite: {
                path: {
                    type: 'ReplacePrefixMatch',
                    replacePrefixMatch: options.prefixRewrite
                }
            }
        });
    }

    // Add more filter conversions here as needed

    return filters;
}

function getUnconvertedOptions(options) {
    const convertibleOptions = ['prefixRewrite'];
    return Object.keys(options)
        .filter(key => !convertibleOptions.includes(key))
        .reduce((obj, key) => {
            obj[key] = options[key];
            return obj;
        }, {});
}

function getOrCreateRouteOption(options, namespace) {
    const hash = getOptionsHash(options, namespace);
    if (optionHashes.RouteOption[hash]) {
        return { name: optionHashes.RouteOption[hash], isNew: false };
    }
    const name = `route-option-${hash.substring(0, 8)}`;
    optionHashes.RouteOption[hash] = name;
    additionalObjects.push(createRouteOption(options, name, namespace));
    return { name, isNew: true };
}

function getOrCreateVirtualHostOption(options, namespace) {
    const hash = getOptionsHash(options, namespace);
    if (optionHashes.VirtualHostOption[hash]) {
        return { name: optionHashes.VirtualHostOption[hash], isNew: false };
    }
    const name = `virtualhost-option-${hash.substring(0, 8)}`;
    optionHashes.VirtualHostOption[hash] = name;
    additionalObjects.push(createVirtualHostOption(options, name, namespace));
    return { name, isNew: true };
}

function getOptionsHash(options, namespace) {
    const optionsString = JSON.stringify(options) + namespace;
    return crypto.createHash('md5').update(optionsString).digest('hex');
}

function createRouteOption(options, name, namespace) {
    return {
        apiVersion: 'gateway.solo.io/v1',
        kind: 'RouteOption',
        metadata: {
            name: name,
            namespace: namespace
        },
        spec: options
    };
}

function createVirtualHostOption(options, name, namespace) {
    return {
        apiVersion: 'gateway.solo.io/v1',
        kind: 'VirtualHostOption',
        metadata: {
            name: name,
            namespace: namespace
        },
        spec: options
    };
}

function getDelegateRouteName(delegateAction) {
    if (delegateAction.selector) {
        // For selector, we might need a naming convention or additional logic
        return `delegate-${Object.values(delegateAction.selector.labels).join('-')}`;
    } else if (delegateAction.ref) {
        return delegateAction.ref.name;
    }
    // Default case if neither selector nor ref is present
    return 'unknown-delegate';
}

function getDelegateRouteNamespace(delegateAction, defaultNamespace) {
    if (delegateAction.selector) {
        return delegateAction.selector.namespaces[0] || defaultNamespace;
    } else if (delegateAction.ref) {
        return delegateAction.ref.namespace || defaultNamespace;
    }
    return defaultNamespace;
}

// Main script
const inputFile = process.argv[2];
const outputFile = process.argv[3];

if (!inputFile || !outputFile) {
    console.error('Usage: node ge2gg.js <input_file> <output_file>');
    process.exit(1);
}

try {
    const inputYaml = fs.readFileSync(inputFile, 'utf8');
    let kubeObjects = [];
    var objects = jsyaml.loadAll(inputYaml);
    
    if (Array.isArray(objects)) {
        objects = objects.filter(item => item !== null);
        objects.forEach(obj => {
            if (obj.kind === 'List' && obj.apiVersion === 'v1' && Array.isArray(obj.items)) {
                kubeObjects.push(...obj.items);
            } else {
                kubeObjects.push(obj);
            }
        });
    } else if(objects) {
        const obj = objects;
        if (obj.kind === 'List' && obj.apiVersion === 'v1' && Array.isArray(obj.items)) {
            kubeObjects.push(...obj.items);
        } else {
            kubeObjects.push(obj);
        }
    }

    let outputYamls = [];
    for (const kubeObject of kubeObjects) {
        if (kubeObject.kind === "VirtualService") {
            const outputYaml = convertVirtualServiceToHttpRoute(kubeObject);
            outputYamls.push(outputYaml);
        } else if (kubeObject.kind === "RouteTable") {
            const outputYaml = convertRouteTableToHttpRoute(kubeObject);
            outputYamls.push(outputYaml);
        }
    }

    additionalObjects.forEach(obj => {
        outputYamls.push(jsyaml.dump(obj));
    });

    fs.writeFileSync(outputFile, outputYamls.join('---\n'));
    console.log(`Conversion successful. Output written to ${outputFile}`);
} catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
}