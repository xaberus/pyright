import {
    CancellationToken,
    integer,
    Range,
    SemanticTokenModifiers,
    SemanticTokenTypes,
} from 'vscode-languageserver-protocol';

import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { convertOffsetToPosition } from '../common/positionUtils';
import { doesRangeContain, TextRange } from '../common/textRange';
import { TextRangeCollection } from '../common/textRangeCollection';
import { FunctionNode, ModuleNode, NameNode, ParseNodeType } from '../parser/parseNodes';
import { ParseResults } from '../parser/parser';
import { Token } from '../parser/tokenizerTypes';
import { AnalyzerFileInfo } from './analyzerFileInfo';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { Declaration, DeclarationType, FunctionDeclaration } from './declaration';
import * as ParseTreeUtils from './parseTreeUtils';
import { ParseTreeWalker } from './parseTreeWalker';
import { TypeEvaluator } from './typeEvaluatorTypes';

export interface SemanticTokenEntry {
    line: integer;
    start: integer;
    length: integer;
    type: SemanticTokenTypes;
    modifiers: SemanticTokenModifiers[];
}

export interface SemanticTokensResult {
    data: SemanticTokenEntry[];
}

export class SemanticTokensGenerator extends ParseTreeWalker {
    private readonly _parseResults: ParseResults;
    private readonly _moduleNode: ModuleNode;
    private readonly _fileInfo: AnalyzerFileInfo;
    private readonly _lines: TextRangeCollection<TextRange>
    private readonly _evaluator: TypeEvaluator;
    private readonly _range: Range | undefined;
    private readonly _data: SemanticTokenEntry[];
    private readonly _cancellationToken: CancellationToken;
    private _dataLen: integer;

    constructor(
        parseResults: ParseResults,
        evaluator: TypeEvaluator,
        range: Range | undefined,
        token: CancellationToken,
    ) {
        super();

        this._parseResults = parseResults;
        this._moduleNode = parseResults.parseTree;
        this._fileInfo = AnalyzerNodeInfo.getFileInfo(this._moduleNode)!;
        this._lines = parseResults.tokenizerOutput.lines;
        this._evaluator = evaluator;
        this._range = range;
        this._cancellationToken = token;
        this._data = [];
        this._dataLen = 0;
    }

    generate(): SemanticTokensResult {
        this.walk(this._moduleNode);
        // return this._builder.build();
        return {
            data: this._data,
        };
    }

    private _pushToken(token: Token, type: SemanticTokenTypes, modifiers: SemanticTokenModifiers[]) {
        const start = token.start;
        const length = token.length;
        const position = convertOffsetToPosition(start, this._lines);

        if (this._range) {
            if (!doesRangeContain(this._range, position)) {
                return;
            }
        }

        this._data[this._dataLen++] = {
            line: position.line,
            start: position.character,
            length: length,
            type: type,
            modifiers: modifiers,
        };
    }

    // override visitCall()

    override visitName(node: NameNode) {
        throwIfCancellationRequested(this._cancellationToken);

        const declarations = this._evaluator.getDeclarationsForNameNode(node);
        if (declarations && declarations.length > 0) {
            const primaryDeclaration: Declaration = declarations[0];
            const resolvedDecl = this._evaluator.resolveAliasDeclaration(primaryDeclaration, true, false);
            const position = convertOffsetToPosition(node.token.start, this._lines);

            const modifiers: SemanticTokenModifiers[] = [];
            if (resolvedDecl) {
                if (doesRangeContain(resolvedDecl.range, position)) {
                    modifiers.push(SemanticTokenModifiers.declaration);
                }

                switch (resolvedDecl.type) {
                     case DeclarationType.Intrinsic: {
                        this._pushToken(node.token, SemanticTokenTypes.macro, modifiers);
                        break;
                    }
                    case DeclarationType.Variable: {
                        const containingClassNode = ParseTreeUtils.getEnclosingClass(resolvedDecl.node, true);
                        if (containingClassNode) {
                            modifiers.push(SemanticTokenModifiers.modification);
                        }
                        this._pushToken(node.token, SemanticTokenTypes.variable, modifiers);
                        break;
                    }
                    case DeclarationType.Parameter: {
                        this._pushToken(node.token, SemanticTokenTypes.parameter, modifiers);
                        break;
                    }
                    case DeclarationType.Function: {
                        const functionDeclaration: FunctionDeclaration = resolvedDecl;
                        let type = SemanticTokenTypes.function;
                        if (functionDeclaration.isMethod) {
                            type = SemanticTokenTypes.method;
                            const functionNode: FunctionNode = functionDeclaration.node;
                            for (const decorator of functionNode.decorators) {
                                if (decorator.expression.nodeType === ParseNodeType.Name) {
                                    const decoratorName = decorator.expression.value;
                                    if (decoratorName === 'staticmethod') {
                                        modifiers.push(SemanticTokenModifiers.static);
                                    } else if (decoratorName === 'classmethod') {
                                        modifiers.push(SemanticTokenModifiers.static);
                                    } else if (decoratorName === 'property') {
                                        type = SemanticTokenTypes.property;
                                    }
                                }
                            }
                        }
                        this._pushToken(node.token, type, modifiers);
                        break;
                    }
                    case DeclarationType.Class: {
                        this._pushToken(node.token, SemanticTokenTypes.class, modifiers);
                        break;
                    }
                    case DeclarationType.SpecialBuiltInClass: {
                        modifiers.push(SemanticTokenModifiers.defaultLibrary);
                        this._pushToken(node.token, SemanticTokenTypes.class, modifiers);
                        break;
                    }
                    case DeclarationType.Alias: {
                        this._pushToken(node.token, SemanticTokenTypes.namespace, modifiers);
                        break;
                    }
                }
            } else {
                if (primaryDeclaration.type === DeclarationType.Alias) {
                    const position = convertOffsetToPosition(node.token.start, this._lines);
                    console.log(`??? ${node.token.value}: ${position.line}:${position.character} ${primaryDeclaration.type}`);
                }
            }
        }
        return true;
    }
}
