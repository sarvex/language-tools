import { AutoInsertionContext, LanguageServicePlugin } from '@volar/language-service';
import { hyphenate } from '@vue/shared';
import type * as ts from 'typescript/lib/tsserverlibrary';
import * as vscode from 'vscode-languageserver-protocol';
import type { TextDocument } from 'vscode-languageserver-textdocument';

const plugin: LanguageServicePlugin = (context) => {

	if (!context?.typescript)
		return {};

	const _ts = context.typescript;

	return {

		async provideAutoInsertionEdit(document, position, insertContext) {

			if (!isTsDocument(document))
				return;

			if (!isCharacterTyping(document, insertContext))
				return;

			const enabled = await context.configurationHost?.getConfiguration<boolean>('volar.features.autoInsert.dotValue') ?? true;
			if (!enabled)
				return;

			const program = _ts.languageService.getProgram();
			if (!program)
				return;

			const sourceFile = program.getSourceFile(context.uriToFileName(document.uri));
			if (!sourceFile)
				return;

			if (isBlacklistNode(_ts.module, sourceFile, document.offsetAt(position), false))
				return;

			const node = findPositionIdentifier(sourceFile, sourceFile, document.offsetAt(position));
			if (!node)
				return;

			const token = _ts.languageServiceHost.getCancellationToken?.();
			if (token) {
				_ts.languageService.getQuickInfoAtPosition(context.uriToFileName(document.uri), node.end);
				if (token?.isCancellationRequested()) {
					return; // check cancel here because type checker do not use cancel token
				}
			}

			const checker = program.getTypeChecker();
			const type = checker.getTypeAtLocation(node);
			const props = type.getProperties();

			if (props.some(prop => prop.name === 'value')) {
				return '${1:.value}';
			}

			function findPositionIdentifier(sourceFile: ts.SourceFile, node: ts.Node, offset: number) {

				let result: ts.Node | undefined;

				node.forEachChild(child => {
					if (!result) {
						if (child.end === offset && _ts.module.isIdentifier(child)) {
							result = child;
						}
						else if (child.end >= offset && child.getStart(sourceFile) < offset) {
							result = findPositionIdentifier(sourceFile, child, offset);
						}
					}
				});

				return result;
			}
		},
	};
};

export default () => plugin;

function isTsDocument(document: TextDocument) {
	return document.languageId === 'javascript' ||
		document.languageId === 'typescript' ||
		document.languageId === 'javascriptreact' ||
		document.languageId === 'typescriptreact';
}

export function isCharacterTyping(document: TextDocument, options: AutoInsertionContext) {

	const lastCharacter = options.lastChange.text[options.lastChange.text.length - 1];
	const rangeStart = options.lastChange.range.start;
	const position = vscode.Position.create(rangeStart.line, rangeStart.character + options.lastChange.text.length);
	const nextCharacter = document.getText(vscode.Range.create(position, document.positionAt(document.offsetAt(position) + 1)));

	if (lastCharacter === undefined) { // delete text
		return false;
	}
	if (options.lastChange.text.indexOf('\n') >= 0) { // multi-line change
		return false;
	}

	return /\w/.test(lastCharacter) && !/\w/.test(nextCharacter);
}

export function isBlacklistNode(ts: typeof import('typescript/lib/tsserverlibrary'), node: ts.Node, pos: number, allowAccessDotValue: boolean) {
	if (ts.isVariableDeclaration(node) && pos >= node.name.getFullStart() && pos <= node.name.getEnd()) {
		return true;
	}
	else if (ts.isFunctionDeclaration(node) && node.name && pos >= node.name.getFullStart() && pos <= node.name.getEnd()) {
		return true;
	}
	else if (ts.isParameter(node) && pos >= node.name.getFullStart() && pos <= node.name.getEnd()) {
		return true;
	}
	else if (ts.isPropertyAssignment(node) && pos >= node.name.getFullStart() && pos <= node.name.getEnd()) {
		return true;
	}
	else if (ts.isShorthandPropertyAssignment(node)) {
		return true;
	}
	else if (ts.isImportDeclaration(node)) {
		return true;
	}
	else if (ts.isLiteralTypeNode(node)) {
		return true;
	}
	else if (ts.isTypeReferenceNode(node)) {
		return true;
	}
	else if (!allowAccessDotValue && ts.isPropertyAccessExpression(node) && node.expression.end === pos && node.name.text === 'value') {
		return true;
	}
	else if (
		ts.isCallExpression(node)
		&& ts.isIdentifier(node.expression)
		&& isWatchOrUseFunction(node.expression.text)
		&& isTopLevelArgOrArrayTopLevelItemItem(node)
	) {
		return true;
	}
	else {
		let _isBlacklistNode = false;
		node.forEachChild(node => {
			if (_isBlacklistNode) return;
			if (pos >= node.getFullStart() && pos <= node.getEnd()) {
				if (isBlacklistNode(ts, node, pos, allowAccessDotValue)) {
					_isBlacklistNode = true;
				}
			}
		});
		return _isBlacklistNode;
	}

	function isWatchOrUseFunction(fnName: string) {
		return fnName === 'watch'
			|| fnName === 'unref'
			|| fnName === 'triggerRef'
			|| fnName === 'isRef'
			|| hyphenate(fnName).startsWith('use-');
	}
	function isTopLevelArgOrArrayTopLevelItemItem(node: ts.CallExpression) {
		for (const arg of node.arguments) {
			if (pos >= arg.getFullStart() && pos <= arg.getEnd()) {
				if (ts.isIdentifier(arg)) {
					return true;
				}
				if (ts.isArrayLiteralExpression(arg)) {
					for (const el of arg.elements) {
						if (pos >= el.getFullStart() && pos <= el.getEnd()) {
							return ts.isIdentifier(el);
						}
					}
				}
				return false;
			}
		}
	}
}
