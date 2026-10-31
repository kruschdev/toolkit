import type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope } from './envelopes.js';

export type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope };

export type SchemaStringFormat =
    | 'email'
    | 'uuid'
    | 'url'
    | 'iso-date'
    | 'iso-datetime'
    | 'ipv4'
    | 'slug';

export type SchemaPrimitive = string | number | boolean;

export interface SchemaIssue {
    path: string;
    code: string;
    message: string;
}

export interface SchemaValidationErrorDetails {
    issues: SchemaIssue[];
    [key: string]: unknown;
}

export interface SafeParseSuccess<T = unknown> {
    success: true;
    data: T;
}

export interface SafeParseFailure {
    success: false;
    error: {
        message: string;
        issues: SchemaIssue[];
    };
}

export type SafeParseResult<T = unknown> = SafeParseSuccess<T> | SafeParseFailure;

export interface JsonSchemaObject {
    type?: string | string[];
    properties?: Record<string, JsonSchemaObject>;
    required?: string[];
    additionalProperties?: boolean | JsonSchemaObject;
    items?: JsonSchemaObject;
    enum?: Array<string | number | boolean | null>;
    const?: unknown;
    anyOf?: JsonSchemaObject[];
    oneOf?: JsonSchemaObject[];
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    format?: string;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    minProperties?: number;
    maxProperties?: number;
    default?: unknown;
    description?: string;
    [key: string]: unknown;
}

export interface SchemaParseOptions {
    coerce?: boolean;
    stripUnknown?: boolean;
    maxDepth?: number;
}

export interface SchemaNode<T = unknown> {
    readonly _output?: T;
    optional(): SchemaNode<T | undefined>;
    nullable(): SchemaNode<T | null>;
    safeParse(input: unknown, options?: SchemaParseOptions): SafeParseResult<T>;
    toJsonSchema(): JsonSchemaObject;
}

export interface ZodLikeIssue {
    path?: ReadonlyArray<PropertyKey> | string;
    code?: string;
    message?: string;
}

export interface ZodLikeSchema<T = unknown> {
    safeParse(input: unknown):
        | { success: true; data: T }
        | {
              success: false;
              error?: {
                  message?: string;
                  issues?: ReadonlyArray<ZodLikeIssue>;
                  errors?: ReadonlyArray<ZodLikeIssue>;
              };
          };
}

export type SchemaInput<T = unknown> = SchemaNode<T> | ZodLikeSchema<T> | JsonSchemaObject;

export type InferSchema<TSchema> = TSchema extends SchemaNode<infer TOut>
    ? TOut
    : TSchema extends ZodLikeSchema<infer TZod>
      ? TZod
      : Record<string, unknown>;

type OptionalShapeKeys<TShape extends Record<string, SchemaInput<any>>> = {
    [K in keyof TShape]: undefined extends InferSchema<TShape[K]> ? K : never;
}[keyof TShape];

type RequiredShapeKeys<TShape extends Record<string, SchemaInput<any>>> = Exclude<
    keyof TShape,
    OptionalShapeKeys<TShape>
>;

type SimplifyShape<T> = { [K in keyof T]: T[K] } & {};

export type InferObjectShape<TShape extends Record<string, SchemaInput<any>>> = SimplifyShape<
    { [K in RequiredShapeKeys<TShape>]: InferSchema<TShape[K]> } &
        { [K in OptionalShapeKeys<TShape>]?: InferSchema<TShape[K]> }
>;

export interface StringSchemaOptions {
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp | string;
    format?: SchemaStringFormat;
    trim?: boolean;
    default?: string;
    description?: string;
}

export interface NumberSchemaOptions {
    min?: number;
    max?: number;
    integer?: boolean;
    default?: number;
    description?: string;
}

export interface IntegerSchemaOptions {
    min?: number;
    max?: number;
    default?: number;
    description?: string;
}

export interface BooleanSchemaOptions {
    default?: boolean;
    description?: string;
}

export interface LiteralSchemaOptions {
    description?: string;
}

export interface EnumSchemaOptions<T extends SchemaPrimitive = SchemaPrimitive> {
    default?: T;
    description?: string;
}

export interface ArraySchemaOptions<T = unknown> {
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    default?: ReadonlyArray<T>;
    description?: string;
}

export interface ObjectSchemaOptions<T = Record<string, unknown>> {
    strict?: boolean;
    stripUnknown?: boolean;
    default?: T;
    description?: string;
}

export interface RecordSchemaOptions {
    maxKeys?: number;
    description?: string;
}

export interface UnionSchemaOptions {
    description?: string;
}

export interface AnySchemaOptions {
    description?: string;
}

export interface SchemaBuilderNamespace {
    string(options?: StringSchemaOptions): SchemaNode<string>;
    number(options?: NumberSchemaOptions): SchemaNode<number>;
    integer(options?: IntegerSchemaOptions): SchemaNode<number>;
    boolean(options?: BooleanSchemaOptions): SchemaNode<boolean>;
    literal<const T extends SchemaPrimitive | null>(
        expectedValue: T,
        options?: LiteralSchemaOptions
    ): SchemaNode<T>;
    enum<const TValues extends ReadonlyArray<SchemaPrimitive>>(
        values: TValues,
        options?: EnumSchemaOptions<TValues[number]>
    ): SchemaNode<TValues[number]>;
    array<TItemSchema extends SchemaInput<any>>(
        itemSchema: TItemSchema,
        options?: ArraySchemaOptions<InferSchema<TItemSchema>>
    ): SchemaNode<Array<InferSchema<TItemSchema>>>;
    object<TShape extends Record<string, SchemaInput<any>>>(
        shape?: TShape,
        options?: ObjectSchemaOptions<InferObjectShape<TShape>>
    ): SchemaNode<InferObjectShape<TShape>>;
    record<TValueSchema extends SchemaInput<any>>(
        valueSchema: TValueSchema,
        options?: RecordSchemaOptions
    ): SchemaNode<Record<string, InferSchema<TValueSchema>>>;
    union<const TBranches extends ReadonlyArray<SchemaInput<any>>>(
        schemas: TBranches,
        options?: UnionSchemaOptions
    ): SchemaNode<InferSchema<TBranches[number]>>;
    optional<TInner extends SchemaInput<any>>(
        innerSchema: TInner
    ): SchemaNode<InferSchema<TInner> | undefined>;
    nullable<TInner extends SchemaInput<any>>(
        innerSchema: TInner
    ): SchemaNode<InferSchema<TInner> | null>;
    any(options?: AnySchemaOptions): SchemaNode<any>;
}

export interface ValidateSchemaOptions {
    coerce?: boolean;
    stripUnknown?: boolean;
    maxDepth?: number;
    tool?: string;
}

export type SchemaMiddlewareSource = 'body' | 'query' | 'params' | 'headers';

export interface SchemaMiddlewareOptions extends ValidateSchemaOptions {
    source?: SchemaMiddlewareSource;
}

export type SchemaMiddlewareNext = (err?: unknown) => unknown;

export type SchemaMiddlewareHandler<
    TValidated = unknown,
    TReq = Record<string, any>,
    TRes = Record<string, any>
> = (req: TReq & { validated?: TValidated }, res: TRes, next?: SchemaMiddlewareNext) => unknown;

export declare const s: Readonly<SchemaBuilderNamespace>;

export declare function toJsonSchema(schema: SchemaInput<any>): JsonSchemaObject;

export declare function validateSchema<TSchema extends SchemaNode<any>>(
    schema: TSchema,
    payload: unknown,
    options?: ValidateSchemaOptions
): LegoEnvelope<InferSchema<TSchema>, SchemaValidationErrorDetails>;
export declare function validateSchema<T = Record<string, unknown>>(
    schema: ZodLikeSchema<T> | JsonSchemaObject,
    payload: unknown,
    options?: ValidateSchemaOptions
): LegoEnvelope<T, SchemaValidationErrorDetails>;

export declare const validatePayload: typeof validateSchema;

export declare function createSchemaMiddleware<TSchema extends SchemaNode<any>>(
    schema: TSchema,
    options?: SchemaMiddlewareOptions
): SchemaMiddlewareHandler<InferSchema<TSchema>>;
export declare function createSchemaMiddleware<T = Record<string, unknown>>(
    schema: ZodLikeSchema<T> | JsonSchemaObject,
    options?: SchemaMiddlewareOptions
): SchemaMiddlewareHandler<T>;
