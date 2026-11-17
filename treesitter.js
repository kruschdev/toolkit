/**
 * @module treesitter
 * @description Portable WebAssembly Tree-sitter CST/AST engine covering 10 languages and
 * 14 enterprise source extensions with zero native C++ `.node` bindings (`INV-LEGO-01`).
 *
 * Gracefully degrades with `TREESITTER_WASM_UNAVAILABLE` when optional `web-tree-sitter` /
 * `tree-sitter-wasms` packages are absent, and supports custom `wasmDir` / `searchRoots`
 * resolution across monorepo workspaces.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { okEnvelope, errorEnvelope } from './http.js';

const localRequire = createRequire(import.meta.url);

export const TREE_SITTER_GRAMMAR_BY_EXTENSION = Object.freeze({
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.py': 'python',
    '.php': 'php',
    '.java': 'java',
    '.cs': 'c_sharp',
    '.go': 'go',
    '.rb': 'ruby',
    '.rs': 'rust',
    '.kt': 'kotlin',
});

export const SUPPORTED_TREESITTER_EXTENSIONS = Object.freeze(
    Object.keys(TREE_SITTER_GRAMMAR_BY_EXTENSION)
);

const ALL_GRAMMAR_NAMES = Object.freeze([
    ...new Set(Object.values(TREE_SITTER_GRAMMAR_BY_EXTENSION)),
]);

let ParserClass = null;
let parserInstance = null;
/** @type {Map<string, any>} */
const loadedLanguages = new Map();
let activeWasmDir = '';
let runtimeReady = false;
let runtimeInitPromise = null;

/**
 * Locate `web-tree-sitter` and `tree-sitter-wasms/out` across standard `node_modules`
 * resolution or explicit caller `searchRoots` / `wasmDir`.
 *
 * @param {object} [options={}]
 * @param {string} [options.wasmDir]
 * @param {string[]} [options.searchRoots]
 * @returns {Promise<{ ParserMod: any, wasmDir: string } | null>}
 */
async function resolveTreeSitterDependencies(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const candidateRoots = [];
    if (Array.isArray(opts.searchRoots)) {
        for (const root of opts.searchRoots) {
            if (typeof root === 'string' && root.trim()) {
                candidateRoots.push(path.resolve(root.trim()));
            }
        }
    }
    const envWasmDir =
        typeof process.env.TREESITTER_WASM_DIR === 'string' &&
        process.env.TREESITTER_WASM_DIR.trim()
            ? path.resolve(process.env.TREESITTER_WASM_DIR.trim())
            : '';

    const candidateRequirers = [localRequire];
    const cwdPkg = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(cwdPkg)) {
        try {
            candidateRequirers.push(createRequire(cwdPkg));
        } catch {
            // Ignore
        }
    }
    for (const root of candidateRoots) {
        const rootPkg = path.join(root, 'package.json');
        if (fs.existsSync(rootPkg)) {
            try {
                candidateRequirers.push(createRequire(rootPkg));
            } catch {
                // Ignore
            }
        }
    }

    let resolvedParserEntry = '';
    for (const req of candidateRequirers) {
        try {
            resolvedParserEntry = req.resolve('web-tree-sitter');
            if (resolvedParserEntry) break;
        } catch {
            // Try next root
        }
    }

    let resolvedWasmOut =
        typeof opts.wasmDir === 'string' && opts.wasmDir.trim()
            ? path.resolve(opts.wasmDir.trim())
            : envWasmDir;

    if (!resolvedWasmOut) {
        for (const req of candidateRequirers) {
            try {
                const pkgJsonPath = req.resolve('tree-sitter-wasms/package.json');
                const outCandidate = path.join(path.dirname(pkgJsonPath), 'out');
                if (fs.existsSync(outCandidate)) {
                    resolvedWasmOut = outCandidate;
                    break;
                }
            } catch {
                // Try next root
            }
        }
    }

    if (!resolvedParserEntry || !resolvedWasmOut || !fs.existsSync(resolvedWasmOut)) {
        return null;
    }

    const imported = await import(pathToFileURL(resolvedParserEntry).href);
    const ParserMod = imported.default || imported.Parser || imported;
    if (!ParserMod || typeof ParserMod.init !== 'function') {
        return null;
    }

    return { ParserMod, wasmDir: resolvedWasmOut };
}

/**
 * Initialize `web-tree-sitter` and preload all 11 WebAssembly language grammars once per process.
 * Never throws; returns `okEnvelope` when ready or `errorEnvelope('TREESITTER_WASM_UNAVAILABLE', ...)`
 * when optional WASM packages are not installed.
 *
 * @param {object} [options={}]
 * @param {string} [options.wasmDir] - Explicit directory containing `tree-sitter-<lang>.wasm` files
 * @param {string[]} [options.searchRoots] - Additional project directories to probe for `node_modules`
 * @param {string} [options.tool='treesitter.init'] - Originating tool identifier
 */
export async function initTreeSitterRuntime(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const safeTool =
        typeof opts.tool === 'string' && opts.tool.trim()
            ? opts.tool.trim()
            : 'treesitter.init';

    if (runtimeReady && parserInstance && loadedLanguages.size === ALL_GRAMMAR_NAMES.length) {
        return okEnvelope(
            safeTool,
            `Tree-sitter WASM runtime ready (${loadedLanguages.size} grammars cached).`,
            {
                ready: true,
                astEngine: 'web-tree-sitter-wasm',
                wasmDir: activeWasmDir,
                grammars: [...loadedLanguages.keys()],
            }
        );
    }

    if (!runtimeInitPromise) {
        runtimeInitPromise = (async () => {
            const deps = await resolveTreeSitterDependencies(opts);
            if (!deps) {
                const missingErr = new Error(
                    'Optional web-tree-sitter / tree-sitter-wasms packages are not installed in search paths.'
                );
                /** @type {any} */ (missingErr).code = 'TREESITTER_WASM_UNAVAILABLE';
                throw missingErr;
            }
            const { ParserMod, wasmDir } = deps;
            await ParserMod.init();
            for (const grammarName of ALL_GRAMMAR_NAMES) {
                if (!loadedLanguages.has(grammarName)) {
                    const wasmPath = path.join(wasmDir, `tree-sitter-${grammarName}.wasm`);
                    const lang = await ParserMod.Language.load(wasmPath);
                    loadedLanguages.set(grammarName, lang);
                }
            }
            ParserClass = ParserMod;
            if (!parserInstance) {
                parserInstance = new ParserClass();
            }
            activeWasmDir = wasmDir;
            runtimeReady = true;
        })().catch((err) => {
            runtimeInitPromise = null;
            throw err;
        });
    }

    try {
        await runtimeInitPromise;
        return okEnvelope(
            safeTool,
            `Initialized Tree-sitter WASM runtime across ${loadedLanguages.size} grammars.`,
            {
                ready: true,
                astEngine: 'web-tree-sitter-wasm',
                wasmDir: activeWasmDir,
                grammars: [...loadedLanguages.keys()],
            }
        );
    } catch (err) {
        const errCode =
            err?.code === 'TREESITTER_WASM_UNAVAILABLE'
                ? 'TREESITTER_WASM_UNAVAILABLE'
                : 'TREESITTER_INIT_FAILED';
        return errorEnvelope(
            errCode,
            err instanceof Error ? err.message : 'Failed to initialize Tree-sitter WASM runtime.',
            null,
            safeTool
        );
    }
}

/**
 * Return whether the WASM parser and all 11 language grammars are loaded in memory.
 *
 * @returns {boolean}
 */
export function isTreeSitterReady() {
    return Boolean(runtimeReady && parserInstance && loadedLanguages.size === ALL_GRAMMAR_NAMES.length);
}

/**
 * Resolve the Tree-sitter grammar identifier for a file path or extension, or `null` if unsupported.
 *
 * @param {string} [filePath='']
 * @returns {string | null}
 */
export function resolveTreeSitterLanguage(filePath = '') {
    const raw = String(filePath || '').trim().toLowerCase();
    if (!raw) return null;
    const ext = raw.startsWith('.') && !raw.slice(1).includes('.') ? raw : path.extname(raw);
    return TREE_SITTER_GRAMMAR_BY_EXTENSION[ext] || null;
}

function unquoteStringText(rawText = '') {
    const text = String(rawText || '').trim();
    if (!text) return '';
    if (
        (text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith("'") && text.endsWith("'")) ||
        (text.startsWith('`') && text.endsWith('`'))
    ) {
        return text.slice(1, -1);
    }
    if (text.startsWith('r"') || text.startsWith("r'")) {
        return text.slice(2, -1);
    }
    return text;
}

function extractFirstLineSignature(node) {
    const firstLine = String(node?.text || '')
        .split(/\r?\n/, 1)[0]
        .replace(/\s*\{\s*$/, '')
        .trim();
    return firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
}

function findFirstNamedChildText(node, candidateTypes) {
    if (!node) return '';
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child && candidateTypes.has(child.type)) {
            return String(child.text || '').trim();
        }
    }
    return '';
}

const IDENT_TYPES = new Set([
    'identifier',
    'type_identifier',
    'simple_identifier',
    'property_identifier',
    'field_identifier',
    'constant',
    'name',
]);

const COMMENT_OR_STRING_TYPES = new Set([
    'comment',
    'line_comment',
    'block_comment',
    'multiline_comment',
    'string',
    'string_literal',
    'interpreted_string_literal',
    'raw_string_literal',
    'encapsed_string',
    'template_string',
    'verbatim_string_literal',
    'interpolated_string_expression',
    'line_string_literal',
    'multi_line_string_literal',
]);

/**
 * Parse `sourceText` using the cached WebAssembly Tree-sitter grammar for `filePath`
 * and extract deterministic CST symbols, imports, call targets, identifiers, namespaces,
 * and syntax error locations across 10 languages / 14 extensions.
 *
 * @param {string} [sourceText='']
 * @param {string} [filePath='']
 * @param {{ tool?: string }} [options={}]
 */
export function analyzeFileWithTreeSitter(sourceText = '', filePath = '', options = {}) {
    const safeTool =
        typeof options?.tool === 'string' && options.tool.trim()
            ? options.tool.trim()
            : 'treesitter.analyze';
    const ext = path.extname(String(filePath || '')).toLowerCase();
    const language = TREE_SITTER_GRAMMAR_BY_EXTENSION[ext] || null;

    if (!language) {
        return okEnvelope(
            safeTool,
            `Extension "${ext || '(none)'}" is not mapped to a Tree-sitter grammar.`,
            {
                supported: false,
                astEngine: 'web-tree-sitter-wasm',
                language: null,
                hasSyntaxError: false,
                syntaxErrors: [],
                packageName: '',
                namespaces: [],
                symbols: [],
                imports: [],
                calls: [],
                identifiers: [],
            }
        );
    }

    const langObj = loadedLanguages.get(language);
    if (!runtimeReady || !parserInstance || !langObj) {
        return errorEnvelope(
            'TREESITTER_NOT_INITIALIZED',
            'Tree-sitter WASM runtime has not been initialized yet. Call await initTreeSitterRuntime() first.',
            { language, filePath },
            safeTool
        );
    }

    const src = String(sourceText ?? '');
    if (src.slice(0, 1024).includes('\0')) {
        return okEnvelope(safeTool, 'Skipped binary source payload.', {
            supported: true,
            astEngine: 'web-tree-sitter-wasm',
            language,
            hasSyntaxError: false,
            syntaxErrors: [],
            packageName: '',
            namespaces: [],
            symbols: [],
            imports: [],
            calls: [],
            identifiers: [],
        });
    }

    const boundedSrc = src.length > 1_500_000 ? src.slice(0, 1_500_000) : src;
    parserInstance.setLanguage(langObj);
    const tree = parserInstance.parse(boundedSrc);

    try {
        const root = tree.rootNode;
        const hasSyntaxError = Boolean(root.hasError);
        const syntaxErrors = [];
        const symbols = [];
        const seenSymbols = new Set();
        const imports = [];
        const seenImports = new Set();
        const callsSet = new Set();
        const identSet = new Set();
        const namespaces = [];
        let packageName = '';

        const isJsFamily =
            language === 'javascript' || language === 'typescript' || language === 'tsx';

        const pushSymbol = (rawName, symbolType, node) => {
            const cleanName = String(rawName || '').trim();
            if (!cleanName || seenSymbols.has(`${symbolType}:${cleanName}:${node.startPosition.row}`)) {
                return;
            }
            seenSymbols.add(`${symbolType}:${cleanName}:${node.startPosition.row}`);
            symbols.push({
                symbol_name: cleanName,
                symbol_type: symbolType,
                start_line: node.startPosition.row + 1,
                end_line: node.endPosition.row + 1,
                signature: extractFirstLineSignature(node),
            });
        };

        const pushImport = (specifier, kind, importedNames = []) => {
            const cleanSpec = String(specifier || '').trim();
            if (!cleanSpec && importedNames.length === 0) return;
            const key = `${kind}:${cleanSpec}:${importedNames.join(',')}`;
            if (seenImports.has(key)) return;
            seenImports.add(key);
            imports.push({
                specifier: cleanSpec,
                kind,
                importedNames,
            });
        };

        const walk = (node, insideClass = false, insideHeader = false) => {
            if (!node) return;
            const type = node.type;

            if ((type === 'ERROR' || node.isMissing) && syntaxErrors.length < 8) {
                const snippet = String(node.text || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 80);
                syntaxErrors.push({
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column + 1,
                    snippet,
                });
            }

            if (COMMENT_OR_STRING_TYPES.has(type)) {
                return;
            }

            if (!insideHeader && IDENT_TYPES.has(type) && identSet.size < 2000) {
                const txt = node.text.trim();
                if (txt) identSet.add(txt);
            }

            let nextInsideClass = insideClass;
            let nextInsideHeader = insideHeader;

            if (isJsFamily) {
                if (
                    type === 'function_declaration' ||
                    type === 'generator_function_declaration'
                ) {
                    pushSymbol(node.childForFieldName('name')?.text, 'function', node);
                } else if (type === 'class_declaration') {
                    pushSymbol(node.childForFieldName('name')?.text, 'class', node);
                    nextInsideClass = true;
                } else if (type === 'method_definition' || type === 'method_signature') {
                    const name = node.childForFieldName('name')?.text;
                    if (name && name !== 'constructor') {
                        pushSymbol(name, 'method', node);
                    }
                } else if (type === 'interface_declaration') {
                    pushSymbol(node.childForFieldName('name')?.text, 'interface', node);
                } else if (type === 'type_alias_declaration') {
                    pushSymbol(node.childForFieldName('name')?.text, 'type', node);
                } else if (type === 'enum_declaration') {
                    pushSymbol(node.childForFieldName('name')?.text, 'enum', node);
                } else if (type === 'variable_declarator') {
                    const nameNode = node.childForFieldName('name');
                    const valueNode = node.childForFieldName('value');
                    if (
                        nameNode?.type === 'identifier' &&
                        valueNode &&
                        (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')
                    ) {
                        pushSymbol(nameNode.text, 'function', node);
                    }
                } else if (type === 'import_statement' || type === 'export_statement') {
                    const srcNode = node.childForFieldName('source');
                    if (srcNode) {
                        pushImport(unquoteStringText(srcNode.text), 'import');
                    }
                    nextInsideHeader = type === 'import_statement';
                } else if (type === 'call_expression' || type === 'new_expression') {
                    const fnNode =
                        node.childForFieldName('function') || node.childForFieldName('constructor');
                    const fnText = fnNode?.text?.trim() || '';
                    if (fnNode?.type === 'identifier') {
                        callsSet.add(fnText);
                    } else if (fnNode?.type === 'member_expression') {
                        const prop = fnNode.childForFieldName('property')?.text?.trim();
                        if (prop) callsSet.add(prop);
                    }
                    if (
                        type === 'call_expression' &&
                        (fnText === 'require' || fnNode?.type === 'import')
                    ) {
                        const args = node.childForFieldName('arguments');
                        const firstArg = args?.namedChild(0);
                        if (
                            firstArg &&
                            (firstArg.type === 'string' ||
                                (firstArg.type === 'template_string' &&
                                    !firstArg.text.includes('${')))
                        ) {
                            pushImport(
                                unquoteStringText(firstArg.text),
                                fnText === 'require' ? 'require' : 'dynamic_import'
                            );
                        }
                    }
                }
            } else if (language === 'python') {
                if (type === 'class_definition') {
                    pushSymbol(node.childForFieldName('name')?.text, 'class', node);
                    nextInsideClass = true;
                } else if (type === 'function_definition') {
                    pushSymbol(
                        node.childForFieldName('name')?.text,
                        insideClass ? 'method' : 'function',
                        node
                    );
                } else if (type === 'import_statement') {
                    nextInsideHeader = true;
                    for (let i = 0; i < node.namedChildCount; i += 1) {
                        const child = node.namedChild(i);
                        if (child?.type === 'dotted_name') {
                            pushImport(child.text.trim(), 'import');
                        } else if (child?.type === 'aliased_import') {
                            const target = child.childForFieldName('name')?.text?.trim();
                            if (target) pushImport(target, 'import');
                        }
                    }
                } else if (type === 'import_from_statement') {
                    nextInsideHeader = true;
                    const modNode = node.childForFieldName('module_name');
                    let modSpec = modNode ? modNode.text.trim() : '';
                    if (!modSpec) {
                        const relChild = findFirstNamedChildText(node, new Set(['relative_import']));
                        if (relChild) modSpec = relChild;
                    }
                    const importedNames = [];
                    for (let i = 0; i < node.namedChildCount; i += 1) {
                        const child = node.namedChild(i);
                        if (!child || child === modNode || child.type === 'relative_import') continue;
                        if (child.type === 'dotted_name' || child.type === 'identifier') {
                            importedNames.push(child.text.trim());
                        } else if (child.type === 'aliased_import') {
                            const orig = child.childForFieldName('name')?.text?.trim();
                            if (orig) importedNames.push(orig);
                        } else if (child.type === 'wildcard_import') {
                            importedNames.push('*');
                        }
                    }
                    pushImport(modSpec, 'from_import', importedNames);
                } else if (type === 'call') {
                    const fnNode = node.childForFieldName('function');
                    if (fnNode?.type === 'identifier') {
                        callsSet.add(fnNode.text.trim());
                    } else if (fnNode?.type === 'attribute') {
                        const attr = fnNode.childForFieldName('attribute')?.text?.trim();
                        if (attr) callsSet.add(attr);
                    }
                }
            } else if (language === 'php') {
                if (type === 'namespace_definition') {
                    const nsName = node.childForFieldName('name')?.text?.trim() || '';
                    if (nsName) {
                        packageName = nsName;
                        pushSymbol(nsName, 'namespace', node);
                    }
                } else if (
                    type === 'class_declaration' ||
                    type === 'interface_declaration' ||
                    type === 'trait_declaration' ||
                    type === 'enum_declaration'
                ) {
                    const kind = type.replace('_declaration', '');
                    pushSymbol(node.childForFieldName('name')?.text, kind, node);
                    nextInsideClass = true;
                } else if (type === 'function_definition' || type === 'method_declaration') {
                    pushSymbol(
                        node.childForFieldName('name')?.text,
                        type === 'method_declaration' ? 'method' : 'function',
                        node
                    );
                } else if (
                    type === 'include_expression' ||
                    type === 'include_once_expression' ||
                    type === 'require_expression' ||
                    type === 'require_once_expression'
                ) {
                    const rawExpr = node.text || '';
                    for (const m of rawExpr.matchAll(/['"]([^'"]+\.php)(?:\?[^'"]*)?['"]/gi)) {
                        if (m[1]) pushImport(m[1], 'requires');
                    }
                } else if (type === 'namespace_use_declaration') {
                    nextInsideHeader = true;
                    for (let i = 0; i < node.namedChildCount; i += 1) {
                        const clause = node.namedChild(i);
                        if (clause) {
                            const qn = clause.text.split(/\s+as\s+/i)[0].trim().replace(/^\\+/, '');
                            if (qn) pushImport(qn, 'use');
                        }
                    }
                } else if (
                    type === 'function_call_expression' ||
                    type === 'scoped_call_expression' ||
                    type === 'object_creation_expression'
                ) {
                    const target =
                        node.childForFieldName('function') ||
                        node.childForFieldName('name') ||
                        node.namedChild(0);
                    if (target) {
                        const cleanTarget = target.text.trim().replace(/^\\+/, '');
                        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanTarget)) {
                            callsSet.add(cleanTarget);
                        }
                    }
                }
            } else if (language === 'go') {
                if (type === 'package_clause') {
                    packageName = findFirstNamedChildText(node, new Set(['package_identifier']));
                    nextInsideHeader = true;
                } else if (type === 'import_spec') {
                    nextInsideHeader = true;
                    const pathNode =
                        node.childForFieldName('path') ||
                        node.namedChildren.find((c) => c.type.includes('string_literal'));
                    if (pathNode) {
                        pushImport(unquoteStringText(pathNode.text), 'import');
                    }
                } else if (type === 'type_spec') {
                    const name = node.childForFieldName('name')?.text;
                    const typeDef = node.childForFieldName('type');
                    const kind =
                        typeDef?.type === 'struct_type'
                            ? 'struct'
                            : typeDef?.type === 'interface_type'
                              ? 'interface'
                              : 'type';
                    pushSymbol(name, kind, node);
                } else if (type === 'function_declaration' || type === 'method_declaration') {
                    const name = node.childForFieldName('name')?.text;
                    pushSymbol(name, type === 'method_declaration' ? 'method' : 'function', node);
                } else if (type === 'call_expression') {
                    const fnNode = node.childForFieldName('function');
                    if (fnNode?.type === 'identifier') {
                        callsSet.add(fnNode.text.trim());
                    } else if (fnNode?.type === 'selector_expression') {
                        const field = fnNode.childForFieldName('field')?.text?.trim();
                        if (field) callsSet.add(field);
                    }
                }
            } else if (language === 'rust') {
                if (type === 'mod_item') {
                    const modName = node.childForFieldName('name')?.text?.trim();
                    const hasInlineBody = Boolean(node.childForFieldName('body'));
                    if (modName) {
                        pushSymbol(modName, 'module', node);
                        if (!hasInlineBody) {
                            pushImport(modName, 'mod');
                        }
                    }
                } else if (type === 'use_declaration') {
                    nextInsideHeader = true;
                    const argNode = node.childForFieldName('argument') || node.namedChild(0);
                    if (argNode) {
                        const rawUse =
                            argNode.type === 'visibility_modifier'
                                ? node.namedChild(1)?.text
                                : argNode.text;
                        if (rawUse) pushImport(rawUse.trim(), 'use');
                    }
                } else if (
                    type === 'struct_item' ||
                    type === 'enum_item' ||
                    type === 'trait_item'
                ) {
                    const kind = type.replace('_item', '');
                    pushSymbol(node.childForFieldName('name')?.text, kind, node);
                } else if (type === 'function_item' || type === 'function_signature_item') {
                    pushSymbol(node.childForFieldName('name')?.text, 'function', node);
                } else if (type === 'call_expression') {
                    const fnNode = node.childForFieldName('function');
                    if (fnNode?.type === 'identifier') {
                        callsSet.add(fnNode.text.trim());
                    } else if (fnNode?.type === 'scoped_identifier') {
                        const name = fnNode.childForFieldName('name')?.text?.trim();
                        if (name) callsSet.add(name);
                    }
                }
            } else if (language === 'java') {
                if (type === 'package_declaration') {
                    nextInsideHeader = true;
                    const pkgNode = node.namedChildren.find(
                        (c) => c.type === 'scoped_identifier' || c.type === 'identifier'
                    );
                    if (pkgNode) packageName = pkgNode.text.trim();
                } else if (type === 'import_declaration') {
                    nextInsideHeader = true;
                    const targetNode = node.namedChildren.find(
                        (c) => c.type === 'scoped_identifier' || c.type === 'identifier'
                    );
                    const hasWildcard = node.namedChildren.some((c) => c.type === 'asterisk');
                    if (targetNode) {
                        pushImport(
                            hasWildcard ? `${targetNode.text.trim()}.*` : targetNode.text.trim(),
                            'import'
                        );
                    }
                } else if (
                    type === 'class_declaration' ||
                    type === 'interface_declaration' ||
                    type === 'enum_declaration' ||
                    type === 'record_declaration'
                ) {
                    const kind = type.replace('_declaration', '');
                    pushSymbol(node.childForFieldName('name')?.text, kind, node);
                    nextInsideClass = true;
                } else if (type === 'method_declaration') {
                    pushSymbol(node.childForFieldName('name')?.text, 'function', node);
                } else if (type === 'method_invocation') {
                    const name = node.childForFieldName('name')?.text?.trim();
                    if (name) callsSet.add(name);
                }
            } else if (language === 'kotlin') {
                if (type === 'package_header') {
                    nextInsideHeader = true;
                    const idNode = findFirstNamedChildText(node, new Set(['identifier']));
                    if (idNode) packageName = idNode.replace(/\s+/g, '');
                } else if (type === 'import_header') {
                    nextInsideHeader = true;
                    const idNode = findFirstNamedChildText(node, new Set(['identifier']));
                    const hasWildcard =
                        node.namedChildren.some((c) => c.type === 'wildcard_import') ||
                        /\.\*\s*$/.test(node.text);
                    if (idNode) {
                        const cleanId = idNode.replace(/\s+/g, '');
                        pushImport(hasWildcard ? `${cleanId}.*` : cleanId, 'import');
                    }
                } else if (type === 'class_declaration' || type === 'object_declaration') {
                    const name = findFirstNamedChildText(
                        node,
                        new Set(['type_identifier', 'simple_identifier'])
                    );
                    const isIface = /^\s*(?:public\s+|internal\s+)?(?:fun\s+)?interface\b/.test(
                        node.text
                    );
                    pushSymbol(
                        name,
                        type === 'object_declaration' ? 'object' : isIface ? 'interface' : 'class',
                        node
                    );
                    nextInsideClass = true;
                } else if (type === 'function_declaration') {
                    const name = findFirstNamedChildText(node, new Set(['simple_identifier']));
                    pushSymbol(name, 'function', node);
                } else if (type === 'call_expression') {
                    const callee = node.namedChild(0);
                    if (callee?.type === 'simple_identifier') {
                        callsSet.add(callee.text.trim());
                    } else if (callee?.type === 'navigation_expression') {
                        const suffix = callee.namedChildren.find(
                            (c) => c.type === 'navigation_suffix'
                        );
                        const methodId = findFirstNamedChildText(
                            suffix,
                            new Set(['simple_identifier'])
                        );
                        if (methodId) callsSet.add(methodId);
                    }
                }
            } else if (language === 'c_sharp') {
                if (
                    type === 'namespace_declaration' ||
                    type === 'file_scoped_namespace_declaration'
                ) {
                    const ns = node.childForFieldName('name')?.text?.replace(/\s+/g, '') || '';
                    if (ns && !namespaces.includes(ns)) {
                        namespaces.push(ns);
                    }
                } else if (type === 'using_directive') {
                    nextInsideHeader = true;
                    const rawUsing = node.text
                        .replace(/^\s*global\s+/i, '')
                        .replace(/^\s*using\s+/i, '')
                        .replace(/^\s*static\s+/i, '')
                        .replace(/;\s*$/, '')
                        .trim();
                    const rhs = rawUsing.includes('=')
                        ? rawUsing.split('=').slice(1).join('=').trim()
                        : rawUsing;
                    if (rhs && !/\s/.test(rhs)) {
                        pushImport(rhs, 'using');
                    }
                } else if (
                    type === 'class_declaration' ||
                    type === 'interface_declaration' ||
                    type === 'struct_declaration' ||
                    type === 'record_declaration' ||
                    type === 'enum_declaration'
                ) {
                    const kind = type.replace('_declaration', '');
                    pushSymbol(node.childForFieldName('name')?.text, kind, node);
                    nextInsideClass = true;
                } else if (type === 'method_declaration') {
                    pushSymbol(node.childForFieldName('name')?.text, 'function', node);
                } else if (type === 'invocation_expression') {
                    const fnNode = node.childForFieldName('function');
                    if (fnNode?.type === 'identifier') {
                        callsSet.add(fnNode.text.trim());
                    } else if (fnNode?.type === 'member_access_expression') {
                        const name = fnNode.childForFieldName('name')?.text?.trim();
                        if (name) callsSet.add(name);
                    }
                }
            } else if (language === 'ruby') {
                if (type === 'module' || type === 'class') {
                    const nameNode =
                        node.childForFieldName('name') ||
                        node.namedChildren.find(
                            (c) => c.type === 'constant' || c.type === 'scope_resolution'
                        );
                    pushSymbol(nameNode?.text, type, node);
                    if (type === 'class') nextInsideClass = true;
                } else if (type === 'method' || type === 'singleton_method') {
                    pushSymbol(node.childForFieldName('name')?.text, 'function', node);
                } else if (type === 'call') {
                    const methodNode = node.childForFieldName('method');
                    const methodName = methodNode?.text?.trim() || '';
                    if (methodName) callsSet.add(methodName);
                    if (methodName === 'require' || methodName === 'require_relative') {
                        const args = node.childForFieldName('arguments');
                        const firstArg = args?.namedChild(0);
                        if (firstArg && firstArg.type === 'string') {
                            const contentNode = firstArg.namedChildren.find(
                                (c) => c.type === 'string_content'
                            );
                            const spec = contentNode
                                ? contentNode.text
                                : unquoteStringText(firstArg.text);
                            if (spec) pushImport(spec, methodName);
                        }
                    }
                }
            }

            if (hasSyntaxError && syntaxErrors.length < 8) {
                for (let i = 0; i < node.childCount; i += 1) {
                    const rawChild = node.child(i);
                    if (
                        rawChild &&
                        !rawChild.isNamed &&
                        (rawChild.type === 'ERROR' || rawChild.isMissing)
                    ) {
                        if (syntaxErrors.length < 8) {
                            syntaxErrors.push({
                                line: rawChild.startPosition.row + 1,
                                column: rawChild.startPosition.column + 1,
                                snippet: String(rawChild.text || rawChild.type || '')
                                    .replace(/\s+/g, ' ')
                                    .trim()
                                    .slice(0, 80),
                            });
                        }
                    }
                }
            }

            for (let i = 0; i < node.namedChildCount; i += 1) {
                walk(node.namedChild(i), nextInsideClass, nextInsideHeader);
            }
        };

        walk(root, false, false);

        return okEnvelope(
            safeTool,
            `Parsed ${filePath || language} with Tree-sitter WASM (${symbols.length} symbol(s), ${imports.length} import(s)).`,
            {
                supported: true,
                astEngine: 'web-tree-sitter-wasm',
                language,
                hasSyntaxError,
                syntaxErrors,
                packageName,
                namespaces,
                symbols,
                imports,
                calls: [...callsSet],
                identifiers: [...identSet],
            }
        );
    } finally {
        tree.delete();
    }
}

/**
 * Convert Tree-sitter CST output into the `{ symbols, imports }` shape expected by `krusch-git`
 * and `@krusch/toolkit/ast` (`extractSymbolsAndImports`), slicing bounded symbol bodies by line range.
 *
 * @param {string} [sourceText='']
 * @param {string} [filePath='']
 * @returns {{ symbols: Array<object>, imports: Array<object>, astEngine: string, hasSyntaxError: boolean } | null}
 */
export function extractTreeSitterSymbolsAndImports(sourceText = '', filePath = '') {
    if (!isTreeSitterReady()) {
        return null;
    }
    const res = analyzeFileWithTreeSitter(sourceText, filePath);
    if (!res.ok || !res.data.supported) {
        return null;
    }

    const lines = String(sourceText ?? '').split(/\r?\n/);
    const symbols = res.data.symbols.map((sym) => {
        const startLine = Math.max(1, Number(sym.start_line) || 1);
        const endLine = Math.max(startLine, Number(sym.end_line) || startLine);
        const bodySlice = lines.slice(startLine - 1, endLine).join('\n').slice(0, 3000);
        return {
            name: sym.symbol_name,
            type: sym.symbol_type,
            symbol_type: sym.symbol_type,
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature: sym.signature,
            content: bodySlice,
        };
    });

    const imports = res.data.imports.map((imp) => ({
        sourcePath: filePath,
        targetPath: imp.specifier,
        module: imp.specifier,
        relation: imp.kind === 'require' || imp.kind === 'requires' || imp.kind === 'require_relative'
            ? 'requires'
            : 'imports',
        symbols: Array.isArray(imp.importedNames) ? imp.importedNames : [],
    }));

    return {
        symbols,
        imports,
        astEngine: 'web-tree-sitter-wasm',
        hasSyntaxError: res.data.hasSyntaxError,
    };
}
