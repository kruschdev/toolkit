import type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope } from './envelopes.js';
import type {
    InferSchema,
    JsonSchemaObject,
    SchemaInput,
    SchemaNode,
    SchemaValidationErrorDetails,
    ZodLikeSchema,
} from './schema.js';

export type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope };

export type YamlByteInput = string | Uint8Array | ArrayBuffer;

export interface YamlLimits {
    readonly maxBytes: number;
    readonly maxDepth: number;
    readonly maxNodes: number;
    readonly maxAliases: number;
    readonly maxAliasExpansionNodes: number;
}

export interface ParseSafeYamlOptions {
    maxBytes?: number;
    maxDepth?: number;
    maxNodes?: number;
    maxAliases?: number;
    maxAliasExpansionNodes?: number;
    allowMultipleDocuments?: boolean;
    tool?: string;
}

export interface ParsedSafeYamlData<TValue = unknown> {
    value: TValue;
    byteLength: number;
    nodeCount: number;
    aliasCount: number;
}

export interface StringifySafeYamlOptions {
    indent?: number;
    sortKeys?: boolean;
    maxDepth?: number;
    tool?: string;
}

export interface StringifySafeYamlData {
    yaml: string;
}

export interface ValidateYamlConfigOptions extends ParseSafeYamlOptions {
    coerce?: boolean;
    stripUnknown?: boolean;
}

export interface ValidateYamlConfigData<TValue = Record<string, unknown>> {
    value: TValue;
    byteLength: number;
    nodeCount: number;
}

export interface LoadSafeYamlPackOptions<
    TSchema extends SchemaInput<any> = SchemaInput<Record<string, unknown>>
> extends ParseSafeYamlOptions {
    requiredKeys?: ReadonlyArray<string>;
    schema?: TSchema | null;
    coerce?: boolean;
    stripUnknown?: boolean;
}

export interface LoadedSafeYamlPackData<TPack = Record<string, unknown>> {
    pack: TPack;
    sha256: string;
    byteLength: number;
    nodeCount: number;
}

export declare const DEFAULT_YAML_LIMITS: Readonly<YamlLimits>;

export declare function parseSafeYaml<TValue = unknown>(
    input: YamlByteInput,
    options?: ParseSafeYamlOptions
): LegoEnvelope<ParsedSafeYamlData<TValue>>;

export declare function stringifySafeYaml(
    value: unknown,
    options?: StringifySafeYamlOptions
): LegoEnvelope<StringifySafeYamlData>;

export declare function validateYamlConfig<TSchema extends SchemaNode<any>>(
    input: YamlByteInput,
    schema: TSchema,
    options?: ValidateYamlConfigOptions
): LegoEnvelope<
    ValidateYamlConfigData<InferSchema<TSchema>>,
    SchemaValidationErrorDetails | Record<string, unknown>
>;
export declare function validateYamlConfig<TValue = Record<string, unknown>>(
    input: YamlByteInput,
    schema: ZodLikeSchema<TValue> | JsonSchemaObject,
    options?: ValidateYamlConfigOptions
): LegoEnvelope<
    ValidateYamlConfigData<TValue>,
    SchemaValidationErrorDetails | Record<string, unknown>
>;

export declare function loadSafeYamlPack<TSchema extends SchemaNode<Record<string, any>>>(
    input: YamlByteInput,
    options: LoadSafeYamlPackOptions<TSchema> & { schema: TSchema }
): LegoEnvelope<LoadedSafeYamlPackData<InferSchema<TSchema>>>;
export declare function loadSafeYamlPack<
    TPack extends Record<string, unknown> = Record<string, unknown>
>(
    input: YamlByteInput,
    options?: LoadSafeYamlPackOptions<SchemaInput<TPack>>
): LegoEnvelope<LoadedSafeYamlPackData<TPack>>;
