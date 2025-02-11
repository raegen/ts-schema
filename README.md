# @raegen/ts-schema

Generate JSON Schema from TypeScript.

## Reasoning

The existing solutions out there fail miserably on complex types. This library aims to provide a more robust solution for generating JSON Schema from TypeScript.

## Installation

```sh
npm install @raegen/ts-schema
```

or

```sh
pnpm add @raegen/ts-schema
```

## Usage

```typescript
import { create } from '@raegen/ts-schema';
import { Project } from 'ts-morph';

// Create a project
const project = new Project({
  tsConfigFilePath: './tsconfig.json',
});

// Create the ts node you want to generate schema from
const node = project.createSourceFile(
  'SomeType.ts',
  `import { SomeType } from '@some/module';

   export type NameOfYourTypeAlias = SomeType`
).getTypeAliasOrThrow('NameOfYourTypeAlias');

// or

const node = project.getSourceFileOrThrow('path/to/your/file.ts').getTypeAliasOrThrow('NameOfYourTypeAlias');

// some types mapped to already built schemas, e.g.
const map = new Map([
    [
        project.createSourceFile('css.ts', `export { CSSProperties } from 'react'`).getExportDeclarations()[0]!.getModuleSpecifierSourceFileOrThrow().getModule('React').getInterface('CSSProperties'),
        {
            $ref: 'https://schemas.com/css'
        }
    ]
])

// add exclusions of certain files (types in those files)
// these are the default exclusions used to avoid the circular hell of dom types, can be overriden by passing []
const exclude = ['**/typescript/lib/lib.dom.d.ts', '**/@types/node/*'];

// optional additional props added to the schema
const props = {};

// generate the schema from node
create(
    node, 
    {
        map,
        exclude,
        ...props
    }
).then((schema) => {
  console.log(schema);
});
```

## Scripts

- `build`: Compiles the TypeScript code.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Issues

If you encounter any issues, please report them [here](https://github.com/raegen/ts-schema/issues).
