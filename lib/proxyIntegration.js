"use strict";

const NO_MATCHING_ACTION = request => {
    throw {
        reason: 'NO_MATCHING_ACTION',
        message: `Could not find matching action for ${request.path} and method ${request.httpMethod}`
    }
};

function addCorsHeaders(toAdd) {
    toAdd["Access-Control-Allow-Origin"] = "*";
    toAdd["Access-Control-Allow-Methods"] = "GET,POST,PUT,DELETE,HEAD,PATCH";
    toAdd["Access-Control-Allow-Headers"] = "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token";
    return toAdd;
}

function processActionAndReturn(actionConfig, event, context, headers, errorMapping) {
    return Promise.resolve(actionConfig.action(event, context)).then(res => {

        if (res && res.body) {
            const mergedHeaders = Object.assign({}, headers, res.headers);

            return Object.assign({
                    statusCode: 200
                },
                res, {
                    headers: mergedHeaders
                });
        } else {
            const consolidateBody = res && JSON.stringify(res) || '{}';

            return {
                statusCode: 200,
                headers: headers,
                body: consolidateBody
            };
        }
    }).catch(err => {
        console.log('Error while handling action function.', err);
        return convertError(err, errorMapping, headers);
    });
}

function process(proxyIntegrationConfig, event, context) {
    if (proxyIntegrationConfig.debug) {
        console.log("EVENT: \n" + JSON.stringify(event, null, 2));
        console.log('CONTEXT: \n' + JSON.stringify(context, null, 2));
    }

    //validate config
    if (!Array.isArray(proxyIntegrationConfig.routes) || proxyIntegrationConfig.routes.length < 1) {
        throw new Error('proxyIntegration.routes must not be empty');
    }

    // detect if it's an http-call at all:
    if (!event.httpMethod || !event.path) {
        return null;
    }

    let headers = {};
    if (proxyIntegrationConfig.cors) {
        addCorsHeaders(headers);
        if (event.httpMethod === 'OPTIONS') {
            return Promise.resolve({
                statusCode: 200,
                headers: headers,
                body: ''
            });
        }
    }
    headers = Object.assign(
        headers, {
            'Content-Type': 'application/json'
        },
        proxyIntegrationConfig.defaultHeaders
    );

    // assure necessary values have sane defaults:
    const errorMapping = proxyIntegrationConfig.errorMapping || {};
    errorMapping['NO_MATCHING_ACTION'] = 404;

    event.path = normalizeRequestPath(event, proxyIntegrationConfig);

    try {
        const actionConfig = findMatchingActionConfig(event.httpMethod, event.path, proxyIntegrationConfig) || {
            action: NO_MATCHING_ACTION
        };

        event.paths = actionConfig.paths;
        if (event.body) {
            try {
                event.body = JSON.parse(event.body);
            } catch (parseError) {
                console.log(`Could not parse body as json: ${event.body}`, parseError);
                return Promise.resolve({
                    statusCode: 400,
                    headers: headers,
                    body: JSON.stringify( { message: "body is not a valid JSON", error: "ParseError" })
                });
            }
        }
        return processActionAndReturn(actionConfig, event, context, headers, errorMapping);
    } catch (error) {
        console.log('Error while evaluating matching action handler', error);
        return Promise.resolve(convertError(error, errorMapping, headers));
    }
}

function normalizeRequestPath(event, routeConfig) {
    // ugly hack: if host is from API-Gateway 'Custom Domain Name Mapping', then event.path has the value '/basepath/resource-path/';
    // if host is from amazonaws.com, then event.path is just '/resource-path':
    const apiId = event.requestContext ? event.requestContext.apiId : null; // the apiId that is the first part of the amazonaws.com-host
    if ((apiId && event.headers && event.headers.Host && event.headers.Host.substring(0, apiId.length) !== apiId) && (routeConfig.removeBasePath === undefined || routeConfig.removeBasePath)) {
        // remove first path element:
        const groups = /\/[^\/]+(.*)/.exec(event.path) || [null, null];
        return groups[1] || '/';
    }

    return event.path;
}

function convertError(error, errorMapping, headers) {
    if (typeof error.reason === 'string' && errorMapping && errorMapping[error.reason]) {
        return {
            statusCode: errorMapping[error.reason],
            body: JSON.stringify({ message: error.message, reason: error.reason}),
            headers: headers
        };
    } else if (typeof error.status === 'number') {
        return {
            statusCode: error.status,
            body: JSON.stringify({ message: error.message, reason: error.status}),
            headers: addCorsHeaders({})
        };
    }
    try {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "ServerError", message:`Server error: ${JSON.stringify(error)}`}),
            headers: addCorsHeaders({})
        };
    } catch (stringifyError) {}

    return {
        statusCode: 500,
        body: JSON.stringify({ error: "ServerError", message:`Server errors: ${JSON.stringify(error.stack ? error.stack : error)}`})
    };
}

function findMatchingActionConfig(httpMethod, httpPath, routeConfig) {
    const paths = {};
    const matchingMethodRoutes = routeConfig.routes.filter(route => route.method === httpMethod);
    for (let route of matchingMethodRoutes) {
        const pathPartNames = extractPathNames(route.path);
        const pathValues = extractPathValues(route.path, httpPath);
        if (pathValues && pathPartNames) {
            for (let ii = 0; ii < pathValues.length; ii++) {
                paths[pathPartNames[ii]] = decodeURIComponent(pathValues[ii]);
            }
            if (routeConfig.debug) {
                console.log(`Found matching route ${route.path} with paths`, paths);
            }
            return {
                action: route.action,
                paths: paths
            };
        }
    }
    if (routeConfig.debug) {
        console.log(`No match for ${httpPath}`);
    }

    return null;
}

function extractPathValues(pathExpression, httpPath) {
    const pathValueRegex = new RegExp('^' + pathExpression.replace(/:[\w]+/g, "([^/]+)") + '$');
    const pathValues = pathValueRegex.exec(httpPath);
    return pathValues && pathValues.length > 0 ? pathValues.slice(1) : null;
}

function extractPathNames(pathExpression) {
    const pathNameRegex = new RegExp('^' + pathExpression.replace(/:[\w.]+/g, ":([\\w]+)") + '$');
    const pathNames = pathNameRegex.exec(pathExpression);
    return pathNames && pathNames.length > 0 ? pathNames.slice(1) : null;
}

module.exports = process;
