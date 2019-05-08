import { SyntaxNode, Tree } from "tree-sitter";
import {
  CompletionItem,
  CompletionItemKind,
  CompletionParams,
  IConnection,
  MarkupKind,
  SymbolKind,
} from "vscode-languageserver";
import { IForest } from "../forest";
import { HintHelper } from "../util/hintHelper";
import { Exposing, TreeUtils } from "../util/treeUtils";
import { VirtualImports } from "../virtualImports";
import { IVirtualImports } from "../virtualImports";

export class CompletionProvider {
  private connection: IConnection;
  private forest: IForest;
  private virtualImports: IVirtualImports;

  constructor(
    connection: IConnection,
    forest: IForest,
    virtualImports: VirtualImports,
  ) {
    this.connection = connection;
    this.forest = forest;
    this.virtualImports = virtualImports;

    this.connection.onCompletion(this.handleCompletionRequest);
  }

  public getCompletionsFromOtherFile(tree: Tree): CompletionItem[] {
    const completions: CompletionItem[] = [];
    let imports = TreeUtils.findAllNamedChildsOfType(
      "import_clause",
      tree.rootNode,
    );

    if (imports) {
      // Add standard imports
      if (this.virtualImports.imports) {
        imports = imports.concat(this.virtualImports.imports);
      }

      imports.forEach(importNode => {
        const moduleNameNode = TreeUtils.findFirstNamedChildOfType(
          "upper_case_qid",
          importNode,
        );
        if (moduleNameNode) {
          const exposedFromRemoteModule = this.forest.getExposingByModuleName(
            moduleNameNode.text,
          );
          if (exposedFromRemoteModule) {
            completions.push(
              ...this.getPrefixedCompletions(
                moduleNameNode,
                importNode,
                exposedFromRemoteModule,
              ),
            );

            const exposingList = TreeUtils.findFirstNamedChildOfType(
              "exposing_list",
              importNode,
            );

            if (exposingList) {
              const doubleDot = TreeUtils.findFirstNamedChildOfType(
                "double_dot",
                exposingList,
              );
              if (doubleDot) {
                completions.push(
                  ...this.getAllExposedCompletions(exposedFromRemoteModule),
                );
              } else {
                const exposedValues = TreeUtils.findAllNamedChildsOfType(
                  "exposed_value",
                  exposingList,
                );
                if (exposedValues) {
                  const exposedNodes = exposedFromRemoteModule.filter(
                    element => {
                      return exposedValues.find(a => a.text === element.name);
                    },
                  );
                  completions.push(
                    ...exposedNodes.map(a => {
                      const value = HintHelper.createHintFromDefinition(
                        a.syntaxNode,
                      );

                      return this.createFunctionCompletion(value, a.name);
                    }),
                  );
                }

                const exposedType = TreeUtils.findAllNamedChildsOfType(
                  "exposed_type",
                  exposingList,
                );
                if (exposedType) {
                  const exposedNodes = exposedFromRemoteModule.filter(
                    element => {
                      return exposedType.find(a => a.text === element.name);
                    },
                  );
                  completions.push(
                    ...exposedNodes.map(a => {
                      const value = HintHelper.createHintFromDefinition(
                        a.syntaxNode,
                      );

                      if (a.type === "Type") {
                        // Todo add type constructors
                        return this.createTypeCompletion(value, a.name);
                      } else {
                        return this.createTypeAliasCompletion(value, a.name);
                      }
                    }),
                  );
                }
              }
            }
          }
        }
      });
    }
    return completions;
  }

  private handleCompletionRequest = (
    param: CompletionParams,
  ): CompletionItem[] | null | undefined => {
    const completions: CompletionItem[] = [];

    const tree: Tree | undefined = this.forest.getTree(param.textDocument.uri);

    if (tree) {
      // Todo add variables from local let scopes
      // Add module exposing_list completions
      // Add import exposing_list completions
      // Add import name completions

      completions.push(...this.getSameFileTopLevelCompletions(tree));

      completions.push(...this.getCompletionsFromOtherFile(tree));

      return completions;
    }
  };

  private getPrefixedCompletions(
    moduleNameNode: SyntaxNode,
    importNode: SyntaxNode,
    exposed: Exposing,
  ): CompletionItem[] {
    const completions: CompletionItem[] = [];

    const importedAs = this.findImportAsClause(importNode);
    const importPrefix = importedAs ? importedAs : moduleNameNode.text;

    exposed.forEach(element => {
      const value = HintHelper.createHintFromDefinition(element.syntaxNode);
      switch (element.type) {
        case "Function":
          completions.push(
            this.createFunctionCompletion(
              value,
              importPrefix + "." + element.name,
            ),
          );
          break;
        case "Type":
          completions.push(
            this.createTypeCompletion(value, importPrefix + "." + element.name),
          );
          if (element.exposedUnionConstructors) {
            completions.push(
              ...element.exposedUnionConstructors.map(a =>
                this.createTypeConstructorCompletion(a),
              ),
            );
          }
          // Todo add type constructors
          break;
        case "TypeAlias":
          completions.push(
            this.createTypeAliasCompletion(
              value,
              importPrefix + "." + element.name,
            ),
          );
          break;
        // Do not handle operators, they are not valid if prefixed
      }
    });

    return completions;
  }

  private getAllExposedCompletions(exposed: Exposing): CompletionItem[] {
    const completions: CompletionItem[] = [];

    exposed.forEach(element => {
      const value = HintHelper.createHintFromDefinition(element.syntaxNode);
      switch (element.type) {
        case "Function":
          completions.push(this.createFunctionCompletion(value, element.name));
          break;
        case "Type":
          completions.push(this.createTypeCompletion(value, element.name));
          break;
        case "TypeAlias":
          completions.push(this.createTypeAliasCompletion(value, element.name));
          break;
        case "Operator":
          completions.push(this.createOperatorCompletion(value, element.name));
          break;
      }
    });

    return completions;
  }

  private getSameFileTopLevelCompletions(tree: Tree): CompletionItem[] {
    const completions: CompletionItem[] = [];
    const functions = TreeUtils.findAllFunctions(tree);
    // Add functions
    if (functions) {
      const declarations = functions.filter(
        a =>
          a.firstNamedChild !== null &&
          a.firstNamedChild.type === "function_declaration_left" &&
          a.firstNamedChild.firstNamedChild !== null &&
          a.firstNamedChild.firstNamedChild.type === "lower_case_identifier",
      );
      for (const declaration of declarations) {
        const value = HintHelper.createHintFromDefinition(declaration);
        completions.push(
          this.createFunctionCompletion(
            value,
            declaration.firstNamedChild!.firstNamedChild!.text,
          ),
        );
      }
    }
    // Add types
    const typeDeclarations = TreeUtils.findAllTypeDeclarations(tree);
    if (typeDeclarations) {
      for (const declaration of typeDeclarations) {
        const value = HintHelper.createHintFromDefinition(declaration);
        const name = TreeUtils.findFirstNamedChildOfType(
          "upper_case_identifier",
          declaration,
        );
        if (name) {
          completions.push(this.createTypeCompletion(value, name.text));
        }
        // Add types constuctors
        const unionVariants = declaration.descendantsOfType("union_variant");
        for (const unionVariant of unionVariants) {
          const unionVariantName = TreeUtils.findFirstNamedChildOfType(
            "upper_case_identifier",
            unionVariant,
          );
          if (unionVariantName) {
            completions.push(
              this.createTypeConstructorCompletion(unionVariantName.text),
            );
          }
        }
      }
    }
    // Add alias types
    const typeAliasDeclarations = TreeUtils.findAllTypeAliasDeclarations(tree);
    if (typeAliasDeclarations) {
      for (const declaration of typeAliasDeclarations) {
        const value = HintHelper.createHintFromDefinition(declaration);
        const name = TreeUtils.findFirstNamedChildOfType(
          "upper_case_identifier",
          declaration,
        );
        if (name) {
          completions.push(this.createTypeAliasCompletion(value, name.text));
        }
      }
    }

    return completions;
  }

  private createFunctionCompletion(
    markdownDocumentation: string | undefined,
    label: string,
  ): CompletionItem {
    return this.createCompletion(
      markdownDocumentation,
      SymbolKind.Function,
      label,
    );
  }

  private createTypeCompletion(
    markdownDocumentation: string | undefined,
    label: string,
  ): CompletionItem {
    return this.createCompletion(markdownDocumentation, SymbolKind.Enum, label);
  }

  private createTypeAliasCompletion(
    markdownDocumentation: string | undefined,
    label: string,
  ): CompletionItem {
    return this.createCompletion(
      markdownDocumentation,
      SymbolKind.Struct,
      label,
    );
  }

  private createOperatorCompletion(
    markdownDocumentation: string | undefined,
    label: string,
  ): CompletionItem {
    return this.createCompletion(
      markdownDocumentation,
      SymbolKind.Operator,
      label,
    );
  }

  private createTypeConstructorCompletion(label: string): CompletionItem {
    return this.createCompletion(undefined, SymbolKind.EnumMember, label);
  }

  private createCompletion(
    markdownDocumentation: string | undefined,
    kind: CompletionItemKind,
    label: string,
  ): CompletionItem {
    return {
      documentation: {
        kind: MarkupKind.Markdown,
        value: markdownDocumentation ? markdownDocumentation : "",
      },
      kind,
      label,
    };
  }

  private findImportAsClause(importNode: SyntaxNode): string | undefined {
    const asClause = TreeUtils.findFirstNamedChildOfType(
      "as_clause",
      importNode,
    );
    if (asClause) {
      const newName = TreeUtils.findFirstNamedChildOfType(
        "upper_case_identifier",
        asClause,
      );
      if (newName) {
        return newName.text;
      }
    }
  }
}
