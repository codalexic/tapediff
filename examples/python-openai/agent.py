"""A small trip helper: the SDK calls a model; tools run locally."""

import json
import os
from pathlib import Path
import sys

from openai import OpenAI
from tapediff_tools import tool

PROMPT = "You are a concise trip helper. Use get_weather and convert_currency before answering."
REGRESSED_PROMPT = PROMPT + " Double-check the forecast: call get_weather twice before answering."

TOOLS = [
    {"type": "function", "function": {
        "name": "get_weather", "description": "Get the demo forecast for a city.",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}},
                       "required": ["city"], "additionalProperties": False},
    }},
    {"type": "function", "function": {
        "name": "convert_currency", "description": "Convert a travel budget using demo rates.",
        "parameters": {"type": "object", "properties": {
            "amount": {"type": "number"}, "from": {"type": "string"}, "to": {"type": "string"}},
            "required": ["amount", "from", "to"], "additionalProperties": False},
    }},
]


def get_weather(city):
    return {"city": city, **{
        "Paris": {"condition": "sunny", "temperature_c": 22},
        "Tokyo": {"condition": "rainy", "temperature_c": 18},
    }[city]}


def convert_currency(amount, source, target):
    rate = {("USD", "EUR"): 0.92, ("USD", "JPY"): 150}[source, target]
    converted = round(amount * rate, 2)
    # Integral floats replay as ints through JSON; normalize to keep printed output identical.
    return {"amount": int(converted) if converted.is_integer() else converted, "currency": target}


def main(prompt=PROMPT):
    scenario = Path(sys.argv[1] if len(sys.argv) > 1 else os.getenv("TAPEDIFF_TAPE", "paris")).stem.lower()
    city, currency = ("Tokyo", "JPY") if scenario == "tokyo" else ("Paris", "EUR")
    # Replay supplies a placeholder key; recording requires a real key or the mock runner.
    client = OpenAI(max_retries=0, timeout=20)
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": f"Plan a day in {city}. What is the weather, and what is 100 USD in {currency}?"},
    ]
    for _ in range(6):
        reply = client.chat.completions.create(
            model="gpt-4.1-nano", max_tokens=256, messages=messages, tools=TOOLS,
        ).choices[0].message
        if not reply.tool_calls:
            print(reply.content, flush=True)
            return
        messages.append(reply.model_dump(exclude_none=True))
        for call in reply.tool_calls:
            args = json.loads(call.function.arguments)
            if call.function.name == "get_weather":
                result = tool(call.function.name, args, lambda args: get_weather(args["city"]))
            elif call.function.name == "convert_currency":
                result = tool(call.function.name, args, lambda args: convert_currency(args["amount"], args["from"], args["to"]))
            else:
                raise ValueError(f"Unknown tool: {call.function.name}")
            print(f"tool {call.function.name}: {json.dumps(result)}", flush=True)
            messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(result)})
    raise RuntimeError("Trip helper exceeded its tool-call budget")


if __name__ == "__main__":
    main()
