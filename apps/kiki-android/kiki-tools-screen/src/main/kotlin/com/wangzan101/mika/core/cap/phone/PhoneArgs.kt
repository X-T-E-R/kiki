package com.wangzan101.mika.core.cap.phone

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.*

internal class PhoneArgError(field: String, problem: String) : IllegalArgumentException("$field: $problem")

internal class PhoneArgs(private val value: JsonObject) {
    fun text(name: String) = (value[name] as? JsonPrimitive)?.contentOrNull
    fun int(name: String) = (value[name] as? JsonPrimitive)?.intOrNull
    fun bool(name: String) = (value[name] as? JsonPrimitive)?.booleanOrNull ?: false
    fun array(name: String) = value[name] as? JsonArray

    companion object {
        fun parse(json: String, schema: JsonObject): PhoneArgs {
            val value = try {
                Json.parseToJsonElement(json) as? JsonObject ?: throw PhoneArgError("arguments", "must be an object")
            } catch (_: SerializationException) {
                throw PhoneArgError("arguments", "must be valid JSON")
            }
            validate("arguments", value, schema)
            return PhoneArgs(value)
        }

        private fun validate(path: String, value: JsonElement, schema: JsonObject) {
            fun number(key: String) = schema[key]?.jsonPrimitive?.int
            fun bounds(n: Int, min: String, max: String) {
                number(min)?.let { if (n < it) throw PhoneArgError(path, "below $min $it") }
                number(max)?.let { if (n > it) throw PhoneArgError(path, "above $max $it") }
            }
            fun wrong(type: String): Nothing = throw PhoneArgError(path, "must be $type")
            val primitive = value as? JsonPrimitive
            when (val type = schema.getValue("type").jsonPrimitive.content) {
                "object" -> {
                    val obj = value as? JsonObject ?: wrong(type)
                    val properties = schema.getValue("properties").jsonObject
                    for (key in schema.getValue("required").jsonArray.map { it.jsonPrimitive.content }) {
                        if (key !in obj) throw PhoneArgError("$path.$key", "required")
                    }
                    for ((key, item) in obj) {
                        val property = properties[key]?.jsonObject ?: throw PhoneArgError("$path.$key", "unknown field")
                        validate("$path.$key", item, property)
                    }
                }
                "array" -> {
                    val array = value as? JsonArray ?: wrong(type)
                    bounds(array.size, "minItems", "maxItems")
                    val items = schema.getValue("items").jsonObject
                    array.forEachIndexed { i, item -> validate("$path[$i]", item, items) }
                }
                "string" -> {
                    if (primitive?.isString != true) wrong(type)
                    bounds(primitive.content.length, "minLength", "maxLength")
                }
                "integer" -> {
                    val n = primitive?.takeUnless { it.isString }?.intOrNull ?: wrong(type)
                    bounds(n, "minimum", "maximum")
                }
                "boolean" -> if (primitive?.takeUnless { it.isString }?.booleanOrNull == null) wrong(type)
                else -> error("Unsupported phone argument schema type $type")
            }
            if (schema["enum"]?.jsonArray?.contains(value) == false) throw PhoneArgError(path, "not an allowed value")
        }
    }
}
