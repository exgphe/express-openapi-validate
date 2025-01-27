/*
  Copyright 2018 Santeri Hiltunen

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import Ajv, {Options as AjvOptions, ErrorObject, KeywordCxt, Code} from "ajv";
import addFormats from "ajv-formats";
// eslint-disable-next-line import/no-extraneous-dependencies
import {RequestHandler} from "express";
import _ from "lodash";
import {pathToRegexp} from "path-to-regexp";
import * as semver from "semver";

import debug from "./debug";
import * as formats from "./formats";
import OpenApiDocument, {
  Operation,
  OperationObject,
  PathItemObject,
  SchemaObject,
} from "./OpenApiDocument";
import * as parameters from "./parameters";
import {
  mapOasSchemaToJsonSchema,
  oasPathToExpressPath,
  resolveReference,
} from "./schema-utils";
import ValidationError from "./ValidationError";
import {_ as $, str, not} from "ajv/dist/compile/codegen"
import * as util from 'ajv/dist/compile/util'

const resolveResponse = (res: any): any => {
  if (res == null) {
    throw new TypeError(`Response was ${String(res)}`);
  }
  const statusCodeNum = Number(res.statusCode || res.status);
  const statusCode = Number.isNaN(statusCodeNum) ? null : statusCodeNum;
  const body = res.body || res.data;
  const {headers} = res;
  if (statusCode == null || body == null || headers == null) {
    throw new TypeError(
      "statusCode, body or header values not found from response",
    );
  }
  return {statusCode, body, headers};
};

export interface ValidatorConfig {
  ajvOptions?: AjvOptions;
  disallowAdditionalPropertiesByDefault?: boolean;
}

export interface PathRegexpObject {
  path: string;
  regex: RegExp;
}

export interface MatchOptions {
  allowNoMatch?: boolean;
}

export default class OpenApiValidator {
  private _ajv: Ajv;

  private _document: OpenApiDocument;
  private disallowAdditionalPropertiesByDefault: boolean;

  constructor(openApiDocument: OpenApiDocument, options: ValidatorConfig = {}) {
    if (!semver.satisfies(openApiDocument.openapi, "^3.0.0")) {
      const version =
        openApiDocument.openapi || (openApiDocument as any).swagger;
      throw new Error(`Unsupported OpenAPI / Swagger version=${version}`);
    }
    this._document = openApiDocument;
    this.disallowAdditionalPropertiesByDefault = options.disallowAdditionalPropertiesByDefault === true
    const userAjvFormats = _.get(options, ["ajvOptions", "formats"], {});
    const ajvOptions: AjvOptions = {
      discriminator: true,
      ...options.ajvOptions,
      formats: {...formats, ...userAjvFormats},
    };
    this._ajv = new Ajv(ajvOptions);
    addFormats(this._ajv, ["date", "date-time"]);
    this._ajv.addKeyword("example");
    this._ajv.addKeyword("xml");
    this._ajv.addKeyword("externalDocs");
    const ignoredExtensionKeywords = ["x-identity", "x-fraction-digits", "x-length", "x-mandatory", "x-anyxml", "x-anydata", "x-choice", "x-path", "x-augmentation", "x-type", "x-union", "x-unions", "x-choices"];
    for (const keyword of ignoredExtensionKeywords) {
      this._ajv.addKeyword(keyword);
    }
    // this._ajv.removeKeyword('anyOf')
    // this._ajv.addKeyword({
    //   keyword: 'anyOf',
    //   schemaType: 'array',
    //   code(cxt: KeywordCxt) {
    //     const {gen, schema, keyword, it} = cxt;
    //     /* istanbul ignore if */
    //     if (!Array.isArray(schema))
    //       throw new Error("ajv implementation error");
    //     const alwaysValid = schema.some((sch) => util.alwaysValidSchema(it, sch));
    //     if (alwaysValid && !it.opts.unevaluated)
    //       return;
    //     const valid = gen.let("valid", false);
    //     const schValid = gen.name("_valid");
    //     gen.block(() => schema.forEach((_sch, i) => {
    //       const schCxt = cxt.subschema({
    //         keyword,
    //         schemaProp: i,
    //         compositeRule: true,
    //       }, schValid);
    //       gen.assign(valid, $`${valid} || ${schValid}`);
    //       const merged = cxt.mergeValidEvaluated(schCxt, schValid);
    //       // can short-circuit if `unevaluatedProperties/Items` not supported (opts.unevaluated !== true)
    //       // or if all properties and items were evaluated (it.props === true && it.items === true)
    //       if (!merged)
    //         gen.if(not(valid));
    //     }));
    //     cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
    //   },
    //   error: {message: "must match a schema in anyOf"},
    //   trackErrors: true,
    // })
    this._ajv.addKeyword({
      keyword: 'x-empty',
      type: 'array',
      schemaType: 'boolean',
      code(cxt: KeywordCxt) {
        cxt.pass($`${cxt.data}.length===1&&${cxt.data}[0]===null`)
      },
      error: {
        message: 'An "empty" value must be represented as "[null]", See RFC7951'
      }
    })
    this._ajv.addKeyword({
      keyword: 'x-range',
      type: ['string', 'integer'],
      schemaType: 'array',
      code(cxt: KeywordCxt) {
        const {gen, data, schemaValue, parentSchema} = cxt
        const valid = gen.let('valid', false)
        const num = gen.let('num', data)
        gen.if($`typeof ${num} === 'string'`, () => {
          const xType = parentSchema['x-type']
          if (xType === 'int64' || xType === 'uint64') {
            gen.assign(num, $`BigInt(${num})`)
          } else {
            gen.assign(num, $`Number(${num})`)
          }
        })
        gen.forOf('range', <Code>schemaValue, (range) => {
          gen.if($`${data} >= ${range}.min && ${data} <= ${range}.max`, () => {
            gen.assign(valid, true)
            gen.break()
          })
        })
        cxt.pass(valid)
      },
      error: {
        message({data, schemaValue}) {
          return str`Value ${data} does not meet the range restrictions: ${$`${schemaValue}.map(range => range.min + ' .. ' + range.max).join(' | ')`}`
        }
      }
    })
  }

  public validate(method: Operation, path: string): RequestHandler {
    const pathItemObject = this._getPathItemObject(path);
    const operation = this._getOperationObject(method, path);
    const requestBodyObject = resolveReference(
      this._document,
      _.get(operation, ["requestBody"], {}),
    );
    const bodySchema = _.get(
      requestBodyObject,
      ["content", "application/yang-data+json", "schema"],
      {},
    );

    const params = parameters.resolve(
      this._document,
      pathItemObject.parameters,
      operation.parameters,
    );
    const parametersSchema = parameters.buildSchema(params);
    const schema = {
      type: "object",
      properties: {
        body: resolveReference(this._document, bodySchema),
        ...parametersSchema,
      },
      required: ["query", "headers", "params"],
    };
    if (!_.isEmpty(parametersSchema.cookies) && Object.keys(parametersSchema.cookies).length > 1) {
      schema.required.push("cookies");
    }

    if (_.get(requestBodyObject, ["required"]) === true) {
      schema.required.push("body");
    }
    const jsonSchema = mapOasSchemaToJsonSchema(schema, this._document, this.disallowAdditionalPropertiesByDefault, method === 'put' || method === 'post');
    if (method === 'post' || method === 'patch' || method === 'put') {
      // TODO find a better place to put this piece of codes
      this._ajv.removeKeyword('readOnly')
      this._ajv.addKeyword({
        keyword: 'readOnly',
        schemaType: 'boolean',
        type: ["string", "number", "integer", "boolean", "null", "object", "array"],
        code(cxt) {
          cxt.error()
        }
      })
    } else {
      this._ajv.removeKeyword('readOnly')
      this._ajv.addKeyword('readOnly')
    }
    if (method === 'patch') {
      this._ajv.removeKeyword('x-key')
      this._ajv.addKeyword('x-key')
    } else {
      this._ajv.removeKeyword('x-key')
      this._ajv.addKeyword({
        keyword: 'x-key',
        type: 'array',
        schemaType: 'string',
        code(cxt: KeywordCxt) {
          const {gen, schema, data} = cxt
          const keys = gen.const('keys', $`${schema}.split(',')`)
          const idSet = gen.const('idSet', $`new Set()`)
          const valid = gen.let("valid", true)
          gen.forOf('item', data, item => {
            const id = gen.let('id', str``)
            gen.forIn('i', keys, i => {
              const key = gen.const('key', $`${keys}[${i}]`)
              gen.if($`${item}[${key}] === undefined || ${item}[${key}] === null`, () => {
                cxt.setParams({errorMessage: str`Key '${key}' is not present in array item`})
                cxt.error()
                gen.break()
              })
              gen.if($`${i}==='0'`)
              gen.assign(id, $`${item}[${key}]`)
              gen.else()
              gen.assign(id, $`${id} + ',' + ${item}[${key}]`)
              gen.endIf()
            })
            gen.if($`${idSet}.has(${id})`, () => {
              cxt.setParams({errorMessage: str`Array item has redundant key '${id}'`})
              cxt.error()
              gen.break()
            })
            gen.code($`${idSet}.add(${id})`)
          })
          cxt.pass(valid)
        },
        error: {
          message: ({params: {errorMessage}}) => str`${errorMessage}`,
        }
      })
    }
    const validator = this._ajv.compile(jsonSchema);
    debug(`Request JSON Schema for ${method} ${path}: %j`, jsonSchema);

    const validate: RequestHandler = (req, res, next) => {
      const reqToValidate = {
        ..._.pick(req, "query", "headers", "params", "body"),
        cookies: req.cookies
          ? {...req.cookies, ...req.signedCookies}
          : undefined,
      };
      const valid = validator(reqToValidate);
      if (valid) {
        next();
      } else {
        const errors = validator.errors as ErrorObject[];
        const errorText = this._ajv.errorsText(errors, {dataVar: "request"});
        const err = new ValidationError(
          `Error while validating request: ${errorText}`,
          errors,
        );
        next(err);
      }
    };

    return validate;
  }

  public match(
    options: MatchOptions = {allowNoMatch: false},
  ): RequestHandler {
    const paths: PathRegexpObject[] = _.keys(this._document.paths).map(
      (path) => ({
        path,
        regex: pathToRegexp(oasPathToExpressPath(path)),
      }),
    );
    const matchAndValidate: RequestHandler = (req, res, next) => {
      const match = paths.find(({regex}) => regex.test(req.path));
      const method = req.method.toLowerCase() as Operation;
      if (match) {
        this.validate(method, match.path)(req, res, next);
      } else if (!options.allowNoMatch) {
        const err = new Error(
          `Path=${req.path} with method=${method} not found from OpenAPI document`,
        );
        next(err);
      } else {
        // match not required
        next();
      }
    };
    return matchAndValidate;
  }

  public validateResponse(method: Operation, path: string): RequestHandler {
    const operation = this._getOperationObject(method, path);
    this._ajv.removeKeyword('x-key')
    this._ajv.addKeyword({
      keyword: 'x-key',
      type: 'array',
      schemaType: 'string',
      code(cxt: KeywordCxt) {
        const {gen, schema, data} = cxt
        const keys = gen.const('keys', $`${schema}.split(',')`)
        const idSet = gen.const('idSet', $`new Set()`)
        const valid = gen.let("valid", true)
        gen.forOf('item', data, item => {
          const id = gen.let('id', str``)
          gen.forIn('i', keys, i => {
            const key = gen.const('key', $`${keys}[${i}]`)
            gen.if($`${item}[${key}] === undefined || ${item}[${key}] === null`, () => {
              cxt.setParams({errorMessage: str`Key '${key}' is not present in array item`})
              cxt.error()
              gen.break()
            })
            gen.if($`${i}==='0'`)
            gen.assign(id, $`${item}[${key}]`)
            gen.else()
            gen.assign(id, $`${id} + ',' + ${item}[${key}]`)
            gen.endIf()
          })
          gen.if($`${idSet}.has(${id})`, () => {
            cxt.setParams({errorMessage: str`Array item has redundant key '${id}'`})
            cxt.error()
            gen.break()
          })
          gen.code($`${idSet}.add(${id})`)
        })
        cxt.pass(valid)
      },
      error: {
        message: ({params: {errorMessage}}) => str`${errorMessage}`,
      }
    })
    const validateResponse: RequestHandler = (req, res, next) => {
      const {statusCode, ...response} = resolveResponse(req);
      const responseObject = this._getResponseObject(operation, statusCode);
      const bodySchema = _.get(
        responseObject,
        ["content", "application/yang-data+json", "schema"],
        {},
      );

      // const headerObjectMap = _.get(responseObject, ["headers"], {});
      const headersSchema: SchemaObject = {
        type: "object",
        properties: {},
      };
      // Object.keys(headerObjectMap).forEach((key) => {
      //   const headerObject = resolveReference(
      //     this._document,
      //     headerObjectMap[key],
      //   );
      //   const name = key.toLowerCase();
      //   if (name === "content-type") {
      //     return;
      //   }
      //   if (headerObject.required === true) {
      //     if (!Array.isArray(headersSchema.required)) {
      //       headersSchema.required = [];
      //     }
      //     headersSchema.required.push(name);
      //   }
      //   (headersSchema.properties as any)[name] = resolveReference(
      //     this._document,
      //     headerObject.schema || {},
      //   );
      // });

      const schema = mapOasSchemaToJsonSchema(
        {
          type: "object",
          properties: {
            body: resolveReference(this._document, bodySchema),
            headers: headersSchema,
          },
          required: [
            "headers",
            "body"],
        },
        this._document,
        this.disallowAdditionalPropertiesByDefault,
        true
      );

      debug(
        `Response JSON Schema for ${method} ${path} ${statusCode}: %j`,
        schema,
      );
      const validator = this._ajv.compile(schema);
      const valid = validator(response);
      if (valid) {
        next();
      } else {
        const errors = validator.errors as ErrorObject[];
        const errorText = this._ajv.errorsText(errors, {dataVar: "request"});
        const err = new ValidationError(
          `Error while validating request: ${errorText}`,
          errors,
        );
        next(err);
      }
    };
    return validateResponse;
  }

  private _getResponseObject(op: OperationObject, statusCode: number): any {
    const statusCodeStr = String(statusCode);
    let responseObject = _.get(op, ["responses", statusCodeStr], null);
    if (responseObject === null) {
      const field = `${statusCodeStr[0]}XX`;
      responseObject = _.get(op, ["responses", field], null);
    }
    if (responseObject === null) {
      responseObject = _.get(op, ["responses", "default"], null);
    }
    if (responseObject === null) {
      throw new Error(
        `No response object found with statusCode=${statusCodeStr}`,
      );
    }
    return resolveReference(this._document, responseObject);
  }

  private _getPathItemObject(path: string): PathItemObject {
    if (_.has(this._document, ["paths", path])) {
      return this._document.paths[path] as PathItemObject;
    }
    throw new Error(`Path=${path} not found from OpenAPI document`);
  }

  private _getOperationObject(
    method: Operation,
    path: string,
  ): OperationObject {
    if (_.has(this._document, ["paths", path, method])) {
      return this._document.paths[path][method] as OperationObject;
    }
    throw new Error(
      `Path=${path} with method=${method} not found from OpenAPI document`,
    );
  }
}
