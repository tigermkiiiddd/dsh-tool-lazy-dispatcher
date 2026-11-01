import { defineTool } from "@deepseek-ai/dsh-tools";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
//#region ../../../vendor/cosmokit/src/misc.ts
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
//#endregion
//#region ../../../vendor/cosmokit/src/volatile.ts
/** Shared config references used by schema validators and plugin runtimes. */
const write = Symbol.for("cosmokit.volatile.write");
function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
	if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
	if (value === null || typeof value !== "object") return value;
	if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
		return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
	} finally {
		ancestors.delete(value);
	}
}
/**
* Create a detached reference containing an immutable copy of the supplied data.
* @param value - validated config data; class instances and functions are unsupported.
* @returns a reference whose value is updated only by its owning runtime.
*/
function createVolatile(value) {
	let current = snapshot(value);
	return Object.freeze({
		get: () => current,
		[write]: (value) => {
			current = value;
		}
	});
}
/**
* Identify references across ESM/CJS copies of the shared library.
* @param value - a parsed config value.
* @returns whether the value implements the shared reference protocol.
*/
function isVolatile(value) {
	return typeof value === "object" && value !== null && write in value;
}
//#endregion
//#region ../../../vendor/cosmokit/src/types.ts
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
let Binary;
(function(_Binary) {
	_Binary.is = isArrayBufferLike;
	_Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	_Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	_Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	_Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	_Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	_Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/**
* Compare values recursively, treating two volatile references as equal regardless of value.
* Strict comparison distinguishes null/undefined, treats opaque objects by identity,
* compares URLs by normalized href, treats array holes as undefined, and considers distinct cyclic structures unequal.
* @param a - first value.
* @param b - second value.
* @param strict - whether to require strict data equality outside volatile references.
* @returns whether the values compare equal.
*/
function deepEqual(a, b, strict) {
	const ancestors = /* @__PURE__ */ new Set();
	function compare(a, b) {
		if (a === b) return true;
		if (isVolatile(a) || isVolatile(b)) return isVolatile(a) && isVolatile(b);
		if (!strict && isNullable(a) && isNullable(b)) return true;
		if (typeof a !== typeof b || typeof a !== "object" || !a || !b) return false;
		if (ancestors.has(a)) return false;
		function check(test, then) {
			return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
		}
		ancestors.add(a);
		try {
			return check(Array.isArray, (a, b) => {
				if (a.length !== b.length) return false;
				for (let index = 0; index < a.length; index++) if (!compare(a[index], b[index])) return false;
				return true;
			}) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("URL"), (a, b) => a.href === b.href) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
				if (a.byteLength !== b.byteLength) return false;
				const viewA = new Uint8Array(a);
				const viewB = new Uint8Array(b);
				for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
				return true;
			}) ?? ((!strict || [a, b].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
				...a,
				...b
			}).every((key) => compare(a[key], b[key])));
		} finally {
			ancestors.delete(a);
		}
	}
	return compare(a, b);
}
//#endregion
//#region ../../../vendor/cosmokit/src/time.ts
let Time;
(function(_Time) {
	_Time.millisecond = 1;
	const second = _Time.second = 1e3;
	const minute = _Time.minute = second * 60;
	const hour = _Time.hour = minute * 60;
	const day = _Time.day = hour * 24;
	const week = _Time.week = day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	_Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	_Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / minute - offset) / 1440);
	}
	_Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * minute);
	}
	_Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * week || 0) + (parseFloat(capture[2]) * day || 0) + (parseFloat(capture[3]) * hour || 0) + (parseFloat(capture[4]) * minute || 0) + (parseFloat(capture[5]) * second || 0);
	}
	_Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	_Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= day - hour / 2) return Math.round(ms / day) + "d";
		else if (abs >= hour - minute / 2) return Math.round(ms / hour) + "h";
		else if (abs >= minute - second / 2) return Math.round(ms / minute) + "m";
		else if (abs >= second) return Math.round(ms / second) + "s";
		return ms + "ms";
	}
	_Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	_Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	_Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region ../../../vendor/schemastery/src/index.ts
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (isVolatile(value)) value = value.get();
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.volatile = function volatile() {
	if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
	return this.extra("volatile", true);
};
const resolvers = {};
const checkedVolatile = Symbol("checked-volatile-schema");
function validateVolatileSchema(schema, path = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
	const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
	if (states.has(blocked)) return;
	states.add(blocked);
	seen.set(schema, states);
	if (schema.meta?.volatile && blocked) throw new ValidationError("volatile fields require a fixed object path without an enclosing volatile field", { path });
	const nested = blocked || !!schema.meta?.volatile;
	if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen);
	if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, "<key>"], true, seen);
	if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path, "*"], true, seen);
	if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path, String(index)], true, seen);
}
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (!options[checkedVolatile]) {
		validateVolatileSchema(schema, options.path);
		options = {
			...options,
			[checkedVolatile]: true
		};
	}
	if (schema.meta?.volatile) {
		const inner = Schema(schema);
		inner.meta = {
			...schema.meta,
			volatile: false
		};
		const [value, adapted] = Schema.resolve(data, inner, options, strict);
		try {
			return [createVolatile(value), adapted];
		} catch (error) {
			throw new ValidationError(error instanceof Error ? error.message : String(error), options);
		}
	}
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
		validateVolatileSchema(schema.inner, options.path, true);
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
//#endregion
//#region src/index.ts
const name = "tool-lazy-dispatcher";
const inject = ["tools", "systemPrompt"];
/**
* Default core tools that remain permanently pinned in the wire schema.
* Defaults are official DSH tools only; non-existent names are harmless
* (intersection with the live registry) but extra local tools should be added via `pinnedTools`.
*/
const DEFAULT_PINNED_TOOLS = [
	"read",
	"read_image",
	"write",
	"edit",
	"str_replace_editor",
	"glob",
	"grep",
	"bash",
	"pwsh",
	"subagent",
	"web_search",
	"web_fetch",
	"skill",
	"ask_user_question",
	"todo_write",
	"present",
	"list_tools",
	"get_tool_schema",
	"call_tool",
	"run_code"
];
const Config = Schema.object({
	lazyToolFolding: Schema.boolean().default(true),
	pinnedTools: Schema.array(Schema.string()).default([]),
	maxFullResults: Schema.natural().default(10)
});
/** Check whether lazy tool folding is currently enabled in settings or config. */
function isFoldingEnabled(ctx, config) {
	if (config.lazyToolFolding === false) return false;
	const settings = ctx.get("settings");
	if (settings) try {
		const entry = settings.describe().find((row) => row.ns === "ui-settings");
		if (entry && typeof entry.value === "object" && entry.value !== null) {
			const val = entry.value.lazyToolFolding;
			if (typeof val === "boolean") return val;
		}
	} catch {}
	return true;
}
/** The only three indispensable meta-tools provided by this dispatcher that must always remain pinned. */
const MANDATORY_META_TOOLS = [
	"list_tools",
	"get_tool_schema",
	"call_tool"
];
/** Resolve the effective set of pinned tool names from defaults, config, and settings. */
function resolvePinnedTools(ctx, config) {
	const pinned = /* @__PURE__ */ new Set();
	let userConfigured = false;
	const settings = ctx.get("settings");
	if (settings) try {
		const entry = settings.describe().find((row) => row.ns === "ui-settings");
		if (entry && typeof entry.value === "object" && entry.value !== null) {
			const raw = entry.value.pinnedTools;
			if (typeof raw === "string" && raw.trim()) {
				userConfigured = true;
				for (const item of raw.split(/[\s,]+/)) if (item.trim()) pinned.add(item.trim());
			}
		}
	} catch {}
	if (!userConfigured) for (const item of DEFAULT_PINNED_TOOLS) pinned.add(item);
	if (Array.isArray(config.pinnedTools)) {
		for (const item of config.pinnedTools) if (item.trim()) pinned.add(item.trim());
	}
	for (const meta of MANDATORY_META_TOOLS) pinned.add(meta);
	return pinned;
}
/**
* Collapse whitespace and accumulate whole sentences up to `max` characters.
* If the first sentence alone exceeds `max`, cut at the last whitespace before `max - 1`
* (or hard cut if none) and append '…'.
*/
function summarizeDescription(desc, max) {
	const clean = desc.replace(/\s+/g, " ").trim();
	if (!clean || max <= 0) return "";
	if (clean.length <= max) return clean;
	const sentences = clean.split(/(?<=[.!?。！？])\s+|(?<=[。！？])/).filter(Boolean);
	if (sentences.length === 0) return "";
	const first = sentences[0];
	if (first.length > max) {
		const limit = max - 1;
		if (limit <= 0) return "…";
		const sub = first.slice(0, limit);
		const lastSpace = sub.lastIndexOf(" ");
		if (lastSpace > 0) return `${sub.slice(0, lastSpace)}…`;
		return `${sub}…`;
	}
	let currentEnd = first.length;
	for (let i = 1; i < sentences.length; i++) {
		const nextStart = clean.indexOf(sentences[i], currentEnd);
		if (nextStart === -1) break;
		const nextEnd = nextStart + sentences[i].length;
		if (nextEnd <= max) currentEnd = nextEnd;
		else break;
	}
	return clean.slice(0, currentEnd);
}
/**
* Format a tool's parameter signature from its JSON-schema properties and required fields.
* If total properties <= 5, optional parameters are listed by name with a `?` suffix (e.g. `call_tool(name?, args?, calls?)`).
* When total properties > 5, outputs `name(req1, req2, +N opt)`, omitting `+N opt` when N=0, or `name()` when no params.
*/
function formatSignature(t) {
	const paramsObj = typeof t.parameters === "object" && t.parameters !== null ? t.parameters : void 0;
	const properties = paramsObj && typeof paramsObj.properties === "object" && paramsObj.properties !== null ? paramsObj.properties : void 0;
	const propKeys = properties ? Object.keys(properties) : [];
	const rawRequired = paramsObj && Array.isArray(paramsObj.required) ? paramsObj.required.filter((r) => typeof r === "string") : [];
	const requiredList = propKeys.length > 0 ? propKeys.filter((k) => rawRequired.includes(k)) : rawRequired;
	const reqSet = new Set(requiredList);
	const optKeys = propKeys.filter((k) => !reqSet.has(k));
	const totalCount = Math.max(propKeys.length, requiredList.length);
	const parts = [...requiredList];
	if (totalCount <= 5) for (const opt of optKeys) parts.push(`${opt}?`);
	else if (optKeys.length > 0) parts.push(`+${optKeys.length} opt`);
	if (parts.length === 0) return `${t.name}()`;
	return `${t.name}(${parts.join(", ")})`;
}
/**
* Defensively parse raw arguments into a record object.
*/
function parseInnerArgs(raw) {
	if (typeof raw === "string") try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
		return { input: raw };
	} catch {
		return { input: raw };
	}
	if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return raw;
	return {};
}
function apply(ctx, config = {}) {
	ctx.tools.register(defineTool({
		name: "list_tools",
		description: "List or search available tools by keyword or intent. Use this to discover specialized tools when uncertain.",
		parameters: {
			action: {
				type: "string",
				enum: ["search", "list"],
				description: "Action to perform: \"search\" to find tools by keyword/intent (default if query is provided), or \"list\" to view tool directory."
			},
			query: {
				type: "string",
				description: "Keyword, capability, or domain to search for (e.g. \"image\", \"screenshot\", \"git\", \"database\", \"sprite\")."
			},
			category: {
				type: "string",
				description: "Optional category filter to narrow down results."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute(args, exec) {
			const allTools = ctx.tools.schemas(exec.agent);
			const action = args.action ?? (args.query ? "search" : "list");
			const query = (args.query ?? "").toLowerCase().trim();
			const categoryFilter = (args.category ?? "").toLowerCase().trim();
			const matches = allTools.filter((t) => {
				if (t.name === "list_tools" || t.name === "get_tool_schema" || t.name === "call_tool") return false;
				if (categoryFilter && !t.name.toLowerCase().includes(categoryFilter) && !t.description.toLowerCase().includes(categoryFilter)) return false;
				if (action === "search" && query) {
					const qParts = query.split(/\s+/).filter(Boolean);
					const nameLower = t.name.toLowerCase();
					const descLower = t.description.toLowerCase();
					return qParts.some((part) => nameLower.includes(part) || descLower.includes(part));
				}
				return true;
			});
			if (matches.length === 0) return Promise.resolve(`No tools found matching query "${query}". Try different keywords or check available tools.`);
			if (action === "list" && !query) {
				const lines = [
					`Found ${matches.length} tool(s):`,
					...matches.map((t) => `- \`${formatSignature(t)}\`: ${summarizeDescription(t.description, 200)}`),
					"",
					"Tip: Call `list_tools({ query: \"<keyword>\" })` to return complete descriptions and parameter schemas for matching tools, or `call_tool({ name: \"<tool_name>\", arguments: { ... } })` to execute."
				];
				return Promise.resolve(lines.join("\n"));
			}
			const maxFull = config.maxFullResults ?? 10;
			const fullMatches = matches.slice(0, maxFull);
			const overflowMatches = matches.slice(maxFull);
			const lines = [`Found ${matches.length} tool(s):`, ""];
			for (const t of fullMatches) {
				const cleanDesc = t.description.replace(/\s+/g, " ").trim();
				lines.push(`### \`${t.name}\``);
				lines.push(cleanDesc);
				lines.push("```json");
				lines.push(JSON.stringify(t.parameters ?? {}));
				lines.push("```");
				lines.push("");
			}
			if (overflowMatches.length > 0) {
				lines.push(`Also matched (refine your query to see their full usage): ${overflowMatches.map((t) => t.name).join(", ")}`);
				lines.push("");
			}
			lines.push("Tip: Call `call_tool({ name: \"<tool_name>\", arguments: { ... } })` to execute.");
			return Promise.resolve(lines.join("\n"));
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.query ? `Search tools: ${args.query}` : "List available tools",
			kind: "other",
			rawInput: args
		})
	}));
	ctx.tools.register(defineTool({
		name: "get_tool_schema",
		description: "Inspect the full JSON schema, parameter specifications, and requirements for a specialized or folded tool before calling it.",
		parameters: {
			name: {
				type: "string",
				description: "The name of a single tool to inspect."
			},
			names: {
				type: "array",
				items: { type: "string" },
				description: "List of tool names for batch schema inspection."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute(args, exec) {
			if (!args.name && (!Array.isArray(args.names) || args.names.length === 0)) throw new Error("Either \"name\" or \"names\" must be provided to inspect tool schema(s).");
			if (Array.isArray(args.names) && args.names.length > 0) {
				const results = args.names.map((toolName) => {
					const def = ctx.tools.get(toolName, exec.agent);
					if (!def) return {
						name: toolName,
						error: `Tool "${toolName}" is not registered or not visible in current scope.`
					};
					return {
						name: def.name,
						description: def.description,
						parameters: def.parameters ?? {}
					};
				});
				return Promise.resolve(JSON.stringify(results, null, 2));
			}
			const targetName = args.name;
			const def = ctx.tools.get(targetName, exec.agent);
			if (!def) throw new Error(`Tool "${targetName}" is not registered or not visible in current scope. Call list_tools to discover available tools.`);
			const schemaDoc = {
				name: def.name,
				description: def.description,
				parameters: def.parameters ?? {}
			};
			return Promise.resolve(JSON.stringify(schemaDoc, null, 2));
		},
		presentCall: (args) => {
			return {
				card: "generic",
				title: args.names && args.names.length > 0 ? `Inspect tool schemas: ${args.names.join(", ")}` : `Inspect tool schema: ${args.name ?? "unknown"}`,
				kind: "other",
				rawInput: args
			};
		}
	}));
	let subCallCounter = 0;
	ctx.tools.register(defineTool({
		name: "call_tool",
		description: "Universal dispatch proxy to execute any available folded or specialized tool by name with its arguments.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "The target tool name to execute."
			},
			arguments: {
				type: "json",
				description: "Arguments payload matching the target tool's parameter schema."
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				if (value && typeof value === "object" && Array.isArray(value.content)) return value.content;
				return [{
					type: "text",
					text: typeof value === "string" ? value : JSON.stringify(value)
				}];
			},
			presentationMeta: (_args, value) => {
				if (value && typeof value === "object" && "meta" in value) {
					const meta = value.meta;
					return meta !== void 0 ? meta : null;
				}
				return null;
			}
		},
		async execute(args, exec) {
			const targetName = args.name;
			const targetArgs = parseInnerArgs(args.arguments);
			const subCallId = ToolCallId(`${String(exec.callId)}:dispatch:${++subCallCounter}:${targetName}`);
			const result = await ctx.tools.execute({
				callId: subCallId,
				rootCallId: exec.rootCallId ?? exec.callId,
				name: targetName,
				arguments: targetArgs,
				...exec.agent !== void 0 ? { agent: exec.agent } : {},
				parent: exec.token,
				signal: exec.signal
			});
			if (result.additionalContexts) for (const extra of result.additionalContexts) exec.deferContext(extra);
			if (result.concludesTurn) exec.concludeTurn();
			if (result.isError) {
				let hint = "";
				const params = ctx.tools.get(targetName, exec.agent)?.parameters;
				const props = params && typeof params.properties === "object" && params.properties !== null ? params.properties : void 0;
				const declared = props ? Object.keys(props) : [];
				if (declared.length > 0) {
					const unknownKeys = Object.keys(targetArgs).filter((k) => !declared.includes(k));
					if (unknownKeys.length > 0) hint = `\nHint: "${targetName}" does not declare parameter(s) ${unknownKeys.join(", ")}. Declared parameters: ${declared.join(", ")}.`;
				}
				throw new Error(`${result.error.message}${hint}`);
			}
			return {
				name: targetName,
				content: result.content.length > 0 ? result.content : [{
					type: "text",
					text: result.value !== void 0 ? typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2) : `Tool "${targetName}" completed successfully with no output.`
				}],
				...result.meta !== void 0 ? { meta: result.meta } : {}
			};
		},
		presentCall(args) {
			const innerArgs = parseInnerArgs(args?.arguments);
			if (args?.name) try {
				const target = ctx.tools.get(args.name);
				if (typeof target?.presentCall === "function") {
					const view = target.presentCall(innerArgs);
					if (view) return view;
				}
			} catch {}
			return {
				card: "generic",
				title: `Call tool: ${args?.name ?? "unknown"}`,
				kind: "other",
				rawInput: innerArgs
			};
		},
		presentResult(args, result) {
			if (!args?.name) return void 0;
			try {
				const target = ctx.tools.get(args.name);
				if (typeof target?.presentResult === "function") {
					const innerArgs = parseInnerArgs(args.arguments);
					const innerResult = {
						content: result.content,
						isError: result.isError,
						...result.meta != null ? { meta: result.meta } : {}
					};
					return target.presentResult(innerArgs, innerResult);
				}
			} catch {
				return;
			}
		}
	}));
	ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
		const assembly = await next();
		if (!isFoldingEnabled(ctx, config)) return assembly;
		if (assembly.tools.length <= 1 && assembly.tools[0]?.name === "run_code") return assembly;
		const pinnedSet = resolvePinnedTools(ctx, config);
		const activeTools = assembly.tools.filter((t) => pinnedSet.has(t.name) || t.name === "list_tools" || t.name === "get_tool_schema" || t.name === "call_tool");
		const foldedTools = assembly.tools.filter((t) => !pinnedSet.has(t.name) && t.name !== "list_tools" && t.name !== "get_tool_schema" && t.name !== "call_tool");
		if (foldedTools.length === 0) return assembly;
		assembly.tools = activeTools;
		const inventoryLines = [
			"## Specialized & Domain Tools (Progressive Disclosure)",
			"To optimize KV Cache and context tokens, full parameter schemas for specialized domain tools are folded.",
			"- To search/discover tools: call `list_tools({ query: \"<keyword>\" })` (returns complete descriptions and parameter schemas for matching tools in one call).",
			"- To view all tool categories or directory: call `list_tools({ action: \"list\" })`.",
			"- To inspect complete parameter specifications: call `get_tool_schema({ name: \"<tool_name>\" })`.",
			"- To execute any folded tool: call `call_tool({ name: \"<tool_name>\", arguments: { ... } })`.",
			"",
			"### Directory of Folded Tools:",
			...foldedTools.map((t) => {
				return `- \`${formatSignature(t)}\`: ${summarizeDescription(t.description, 140)}`;
			})
		];
		assembly.sections.push({
			name: "tools:lazy-directory",
			text: inventoryLines.join("\n")
		});
		return assembly;
	});
}
//#endregion
export { Config, DEFAULT_PINNED_TOOLS, MANDATORY_META_TOOLS, apply, formatSignature, inject, name, parseInnerArgs, summarizeDescription };
