import Ajv, { SchemaObject, stringify } from 'ajv';
import { createHash } from 'node:crypto';
import pm from 'picomatch';
import { Node, Type } from 'ts-morph';

const tagSchema = (schema: SchemaObject) => ({
  $schema: 'http://json-schema.org/draft-07/schema#',
  ...schema,
});
const unique = <T, >(values: T[]) => [...new Set(values)];

const hash = (value: SchemaObject | null) => {
  try {
    return createHash('sha256').update(stringify(value).toString()).digest('hex');
  } catch (e) {
    return null;
  }
};
const isDefined = (type: Type) => type && !type.isUndefined();
const unquote = (value: string) => value.replace(/^['"]|['"]$/g, '');

const wipe = (obj: Record<string, unknown>) => {
  for (const key in obj) {
    delete obj[key];
  }
};

const prune = (schema: SchemaObject) => {
  const refs: string[] = JSON.stringify(schema).match(/(?<="#\/\$defs\/)[^"]+(?=")/g) || [];

  return {
    ...schema,
    $defs: Object.fromEntries(Object.entries(schema.$defs).filter(([ref]) => refs.includes(ref))),
  };
};

const getSourceFiles = (type: Type) =>
  type
    .getSymbol()
    ?.getDeclarations()
    .map((declaration) => declaration.getSourceFile().getFilePath()) || [];
const isNotEmptySchema = (schema: SchemaObject) => Object.keys(schema).some((key) => key !== '$comment');
const isSchema = (value: unknown): value is SchemaObject =>
  !!value && typeof value === 'object' && !Array.isArray(value) && isNotEmptySchema(value);

const flatten = (schema: SchemaObject) => {
  if (schema.anyOf?.length === 1) {
    return flatten(schema.anyOf[0]);
  } else if (schema.allOf?.length === 1) {
    return flatten(schema.allOf[0]);
  }
  return schema;
};

const generateId = (() => {
  let index = 0;
  return () => index++;
})();

class Cache<K> {
  store = new Map<K, SchemaObject>();
  refs = new Set<K>();

  get(key: K) {
    const value = this.store.get(key);
    if (value) {
      this.refs.add(key);
    }
    return value;
  }

  has(key: K) {
    return this.store.has(key);
  }

  set(key: K, value: SchemaObject) {
    this.store.set(key, value);
  }

  defs(path = '#/$defs') {
    const $defs: Record<string, SchemaObject> = {};
    for (const ref of [...this.refs]) {
      const schema = this.store.get(ref)!;
      const id = generateId();
      $defs[id] = { ...schema };
      wipe(schema);
      schema.$ref = `${path}/${id}`;
      this.store.delete(ref);
      this.refs.delete(ref);
    }
    return $defs;
  }
}

const defaultExclude = ['**/typescript/lib/lib.dom.d.ts', '**/@types/node/*'];

export const create = async (node: Node, { map = new Map(), exclude = defaultExclude, ...props }: SchemaObject & {
  map?: Map<Type, SchemaObject>;
  exclude?: string[] | string;
} = {}): Promise<SchemaObject> => {
  const project = node.getProject();
  const checker = project.getTypeChecker();

  const isArrayLike = (type: Type) => checker.compilerObject.isArrayLikeType(type.compilerType);

  const getMapped = (type: Type) => map.get(type) || null;

  const isExcluded = (
    (exclude) => (type: Type) =>
      getSourceFiles(type).some(exclude)
  )(pm(exclude));

  const cache = {
    types: new Cache(),
    schemas: new Cache(),
  };

  const create = (type: Type, root = false): SchemaObject | null => {
    const mapped = getMapped(type);
    if (mapped) {
      return mapped;
    }
    if (isExcluded(type)) {
      return null;
    }
    if (type.isStringLiteral()) {
      return { enum: [unquote(type.getText())] };
    }
    if (type.isString()) {
      return { type: 'string' };
    }
    if (type.isBoolean()) {
      return { type: 'boolean' };
    }
    if (type.isBooleanLiteral()) {
      return { enum: [unquote(type.getText()) === 'true'] };
    }
    if (type.isNumber()) {
      return { type: 'number' };
    }
    if (type.isNumberLiteral()) {
      return { enum: [Number(unquote(type.getText()))] };
    }
    if (type.isEnumLiteral()) {
      const members = type
        .getProperties()
        .map((property) => property.getValueDeclaration()?.getText())
        .filter(Boolean);
      return {
        enum: unique(members),
      };
    }
    if (type.isNull()) {
      return {
        type: 'null',
      };
    }
    if (type.isClass() || type.getConstructSignatures().length) {
      return null;
    }
    if (type.isTuple()) {
      const elements = type.getTupleElements().filter(isDefined);
      if (!elements.length) {
        return {
          type: 'array',
        };
      }
      return {
        type: 'array',
        items: elements.map((element) => create(element)),
      };
    }
    if (isArrayLike(type)) {
      const elementType = type.getArrayElementType();
      if (elementType) {
        return {
          type: 'array',
          items: create(elementType),
        };
      }
      return {
        type: 'array',
      };
    }

    const schema: SchemaObject = {};
    if (!root) {
      if (type === node.getType()) {
        return {
          $ref: '#',
        };
      }
      if (cache.types.has(type)) {
        return cache.types.get(type)!;
      }
      cache.types.set(type, schema);
    }

    const result = ((type) => {
      if (type.isEnum()) {
        const members = unique(
          type
            .getProperties()
            .map((property) => property.getValueDeclaration()?.getText())
            .filter(Boolean),
        );
        if (!members.length) {
          return null;
        }
        return Object.assign(schema, { enum: unique(members) });
      }
      if (type.isUnion()) {
        const types = unique(type.getUnionTypes().filter(isDefined))
          .map((type) => create(type))
          .filter(isSchema);

        const anyOf = new Set();
        const enums = new Set();
        for (const type of types) {
          if (type.enum) {
            for (const value of type.enum) {
              enums.add(value);
            }
          } else if (type.anyOf) {
            for (const value of type.anyOf) {
              anyOf.add(value);
            }
          } else {
            anyOf.add(type);
          }
        }
        if (enums.size) {
          anyOf.add({ enum: [...enums] });
        }
        if (!anyOf.size) {
          return null;
        }
        return Object.assign(schema, flatten({ anyOf: [...anyOf] }));
      }
      if (type.isIntersection()) {
        const types = unique(type.getIntersectionTypes().filter(isDefined))
          .map((type) => create(type))
          .filter(isSchema);

        if (!types.length) {
          return null;
        }
        return Object.assign(
          schema,
          flatten({
            allOf: types,
          }),
        );
      }
      const properties = type.getProperties();
      for (const property of properties) {
        const propType = property.getTypeAtLocation(node);
        const propSchema = propType && create(propType);
        if (isSchema(propSchema)) {
          schema.properties = {
            ...schema.properties,
            [property.getName()]: propSchema,
          };
        }
      }
      if (!schema.properties) {
        return null;
      }
      return schema;
    })(type);

    const id = hash(result);
    if (id) {
      if (cache.schemas.has(id)) {
        return cache.schemas.get(id)!;
      }

      cache.schemas.set(id, result!);
    }

    return result;
  };

  const schema = {
    ...create(node.getType(), true),
    ...props,
  };

  schema.$defs = {
    ...cache.types.defs(),
    ...cache.schemas.defs(),
  };

  const optimized = prune(schema);

  const ajv = new Ajv();
  await ajv.validateSchema(optimized, true);
  return tagSchema(optimized);
};

export { Project } from 'ts-morph';
