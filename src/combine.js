module.exports = combine;

const BUILT_IN = ['Query', 'Mutation', 'Subscription'];
const SCALARS = ['String', 'Int', 'Float', 'ID', 'Boolean'];

const { GraphQLNonNull, GraphQLList } = require('graphql');

const {
    SchemaComposer,
    ObjectTypeComposer,
    InputTypeComposer,
    EnumTypeComposer,
    ScalarTypeComposer,
    Resolver
} = require('graphql-compose');

function combine({ schema1, schema2, handleConflict = () => true }) {
    const composer = new SchemaComposer();

    for (const name of typeNames(schema1)) {
        process(name);
    }

    for (const name of typeNames(schema2)) {
        process(name);
    }

    return composer;

    function typeNames(schema) {
        return Array.from(schema.entries()).map(([name]) => name)
            .filter(name => typeof name === 'string');
    }

    function process(name) {
        if (SCALARS.includes(name)) {
            return;
        }
        if (Array.from(composer.entries()).map(([name]) => name).map(typeName).includes(name)) {
            return;
        }
        if (schema1.has(name) && schema2.has(name)) {
            const source = handleConflict(schema1.get(name), schema2.get(name));
            if (source === true) {
                merge(composer, schema1.get(name), schema2.get(name));
            } else if (source) {
                copy(composer, source);
            }
        } else {
            copy(composer, schema2.has(name) && schema2.get(name) || schema1.has(name) && schema1.get(name));
        }
    }
}

function copy(schema, type) {
    if (type instanceof ObjectTypeComposer) {
        const objectTypeName = type.getTypeName();
        const clonedType = BUILT_IN.includes(objectTypeName) ?
            schema[objectTypeName] || schema.createObjectTC({ name: type.getTypeName() }) :
            schema.createObjectTC({ name: type.getTypeName() });
        clonedType.setDescription(type.getDescription() || '');
        type.getInterfaces().map(typeName).forEach(interfaceName => clonedType.addInterface(interfaceName));
        clonedType.setExtensions(type.getExtensions());
        for (const [resolverName, resolver] of type.getResolvers()) {
            cloneResolver(clonedType, resolverName, resolver);
        }
        type.getFieldNames().forEach(name => process(clonedType, name));
    } else if (type instanceof InputTypeComposer) {
        // TODO.... how to get the fields properly?
        //   all fields are returning undefined
        const clonedType = schema.createInputTC({ name: type.getTypeName() });
        clonedType.setDescription(type.getDescription() || '');
        clonedType.setExtensions(type.getExtensions());
        type.getFieldNames().forEach(name => process(clonedType, name));
    } else if (type instanceof EnumTypeComposer) {
        const clonedType = schema.createEnumTC({ name: type.getTypeName(), values: {} });
        const fields = type.getFields();
        Object.keys(fields).forEach(field => clonedType.setField(field, {
            value: fields[field].value,
            deprecationReason: fields[field].deprecationReason,
            description: fields[field].description,
            extensions: fields[field].extensions
        }));
    } else if (type instanceof ScalarTypeComposer) {
        schema.createScalarTC(type.getTypeName());
    }

    function process(clonedType, fieldName) {
        const field = type.getField(fieldName);
        if (field.type instanceof Resolver) {
            processResolverField(clonedType, fieldName, getResolverName, field.type);
        } else {
            processStandardField(
                clonedType,
                fieldName,
                field,
                copyArgs(field.args),
                type.getDescription(),
                type.extensions
            );
        }

        function getResolverName(resolver) {
            for (const [name, res] of type.getResolvers()) {
                if (res === resolver) {
                    return name;
                }
            }
            return undefined;
        }
    }
}

function merge(composer, type1, type2) {
    if (type1.constructor !== type2.constructor) {
        throw new Error('Cannot merge types created from different constructors');
    }

    if (type1 instanceof ObjectTypeComposer) {
        objectMerge(composer, type1, type2, name => schema.createObjectTC({ name }));
    } else if (type1 instanceof InputTypeComposer) {
        objectMerge(composer, type1, type2, name => schema.createInputTC({ name }));
    } else if (type1 instanceof EnumTypeComposer) {
        enumMerge(composer, type1, type2);
    } else if (type1 instanceof ScalarTypeComposer) { // TODO: Is this correct?
        if (type1.getTypeName() === type2.getTypeName()) {
            return type1;
        } else {
            throw new Error('Unable to merge scalar types');
        }
    } else {
        throw new Error(`Unable to merge ${type1.constructor.name} types`);
    }
}

function enumMerge(composer, enum1, enum2) {
    const enumTc = composer.createEnumTC({ name: enum2.getTypeName() });
    for (const [name, definition] of enum2.getFields()) {
        enumTc.setField(name, {
            value: definition.value,
            extensions: definition.extensions,
            description: definition.description,
            deprecationReason: definition.deprecationReason,
        });
    }
    for (const [name, definition] of enum1.getFields()) {
        if (enumTc.hasField(name)) {
            continue;
        }
        enumTc.setField(name, {
            value: definition.value,
            extensions: definition.extensions,
            description: definition.description,
            deprecationReason: definition.deprecationReason,
        });
    }
}

function objectMerge(composer, type1, type2, create) {
    const composer = create(type2.getTypeName());

    composer.setDescription(type2.getDescription() || type1.getDescription() || '');
    type1.getInterfaces().map(typeName)
        .union(type2.getInterfaces().map(typeName))
        .forEach(interfaceName => composer.addInterface(interfaceName));

    composer.setExtensions(Object.assign(type1.getExtensions(), type2.getExtensions()));

    for (const [resolverName, resolver] of type2.getResolvers()) {
        cloneResolver(resolverName, resolver);
    }
    for (const [resolverName, resolver] of type1.getResolvers()) {
        if (!composer.hasResolver(resolverName)) {
            cloneResolver(resolverName, resolver);
        }
    }

    type1.getFieldNames().forEach(process);
    type2.getFieldNames().filter(name => !tc.has(name)).forEach(process);

    return composer;

    function process(fieldName) {
        const field1 = type1.getField(fieldName);
        const field2 = type2.getField(fieldName);

        const field = field2 || field1;
        if (field.type instanceof Resolver) {
            return processResolverField(field.type);
        } else {
            return processStandardField(field);
        }

        function processStandardField() {
            return clean({
                type: field.getTypeName(),
                args: combineArgs(field1 && field1.args, field2 && field2.args),
                resolve: field.resolve,
                subscribe: field.subscribe,
                deprecationReason: field.deprecationReason,
                description: getDescription(),
                astNode: field.astNode,
                extensions: combineExtensions()
            });

            function combineArgs(args1, args2) {
                throw new Error('not implemented');
            }

            function getDescription() {
                return field2 && field2.description || field1 && field1.description || '';
            }

            function combineExtensions() {
                return {
                    ...(field1 && field1.extensions || {}),
                    ...(field2 && field2.extensions || {})
                };
            }
        }

        function processResolverField(resolver) {
            let resolverName;
            for (const [resName, res] of type2.getResolvers()) {
                if (res === resolver) {
                    resolverName = resName;
                    break;
                }
            }
            if (!resolverName) {
                for (const [resName, res] of type1.getResolvers()) {
                    if (res === resolver) {
                        resolverName = resName;
                        break;
                    }
                }
            }

            if (resolverName) {
                return composer.getResolver(resolverName);
            } else {
                return cloneResolver(undefined, resolver);
            }
        }
    }

    function cloneResolver(name, resolver) {
        const resolverClone = composer.addResolver({ name });

        resolverClone.setType(typeName(resolver.getTypeName()));
        resolver.getArgNames().forEach(name => {
            const arg = resolver.getArg(name);
            resolverClone.setArg(name, {
                type: typeName(arg.type),
                defaultValue: arg.defaultValue,
                description: arg.description,
                extensions: arg.extensions
            });
        });

        resolverClone.setResolve(resolver.getResolve());
        return resolverClone;
    }
}

function processStandardField(composer, name, field, args, description, extensions) {
    composer.setField(name, clean({
        args,
        extensions,
        description,
        resolve: field.resolve,
        astNode: field.astNode,
        type: typeName(field.type),
        subscribe: field.subscribe,
        deprecationReason: field.deprecationReason,
    }));
}

function processResolverField(composer, name, getResolverName, resolver) {
    const resolverName = getResolverName(resolver);
    if (resolverName) {

        resolver = composer.getResolver(resolverName);
    } else {
        resolver = cloneResolver(composer, undefined, resolver);
    }
    composer.setField(name, resolver);
}

function cloneResolver(composer, name, resolver) {
    composer.addResolver({ name });
    const resolverClone = composer.getResolver(name);

    resolverClone.setType(typeName(resolver.type));
    resolver.getArgNames().forEach(name => {
        const arg = resolver.getArg(name);
        resolverClone.setArg(name, {
            type: typeName(arg.type),
            defaultValue: arg.defaultValue,
            description: arg.description,
            extensions: arg.extensions
        });
    });

    resolverClone.setResolve(resolver.getResolve());
    return resolverClone;
}

function copyArgs(args) {
    if (args) {
        return Object.keys(args).reduce((result, argName) => copyArg(args, result, argName), {});
    } else {
        return undefined;
    }
}

function copyArg(args, result, argName) {
    const arg = args[argName];
    result[argName] = {
        type: typeName(arg.type),
        defaultValue: arg.defaultValue,
        description: arg.description,
        astNode: arg.astNode,
        extensions: arg.extensions
    };
    return result;
}

function typeName(type) {
    if (typeof type === 'string') {
        return type;
    } else if (typeof type.getTypeName === 'function') {
        return type.getTypeName();
    } else if (type instanceof GraphQLNonNull) {
        return `${typeName(type.ofType)}!`;
    } else if (type instanceof GraphQLList) {
        return `[${typeName(type.ofType)}]`;
    } else {
        return type.name;
    }
}

function clean(obj) {
    if (obj && typeof obj === 'object') {
        Object.keys(obj).forEach(key => {
            if (obj[key] === undefined) {
                delete obj[key];
            }
        });
    }
    return obj;
}
