"""Research a trip, draft a plan, then check it against the tool facts."""

import json
from typing import TypedDict

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool as model_tool
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from tapediff_tools import tool

DRAFT_PROMPT = "Draft a day plan. Label the weather number as Fahrenheit. Keep the budget in EUR."
FIXED_PROMPT = "Draft a day plan. Label the weather number as Celsius. Keep the budget in EUR."


class Trip(TypedDict):
    request: str
    facts: str
    plan: str
    review: str


def forecast(args):
    print("executing get_weather", flush=True)
    return {"city": args["city"], "condition": "sunny", "temperature_c": 22}


def exchange(args):
    print("executing convert_currency", flush=True)
    if (args["source"], args["target"]) != ("USD", "EUR"):
        raise ValueError("The demo supports USD to EUR only")
    return {"amount": int(args["amount"] * 0.92), "currency": "EUR"}


@model_tool
def get_weather(city: str) -> dict:
    """Get the demo forecast in Celsius."""
    return tool("get_weather", {"city": city}, forecast)


@model_tool
def convert_currency(amount: int, source: str, target: str) -> dict:
    """Convert a whole-dollar demo budget from USD to EUR."""
    return tool("convert_currency", {"amount": amount, "source": source, "target": target}, exchange)


def main(draft_prompt=DRAFT_PROMPT):
    llm = ChatOpenAI(model="gpt-4.1-nano", max_tokens=256, max_retries=0, timeout=20)
    tools = {fn.name: fn for fn in [get_weather, convert_currency]}
    researcher = llm.bind_tools(list(tools.values()))

    def research(state):
        messages = [SystemMessage(content="Research the trip. Use get_weather and convert_currency before answering."),
                    HumanMessage(content=state["request"])]
        facts = {}
        for _ in range(6):
            reply = researcher.invoke(messages)
            messages.append(reply)
            if not reply.tool_calls:
                if set(facts) != set(tools):
                    raise RuntimeError("Research did not collect both facts")
                return {"facts": json.dumps(facts)}
            for call in reply.tool_calls:
                result = tools[call["name"]].invoke(call["args"])
                facts[call["name"]] = result
                messages.append(ToolMessage(content=json.dumps(result), tool_call_id=call["id"]))
        raise RuntimeError("Research exceeded its tool-call budget")

    def draft(state):
        reply = llm.invoke([SystemMessage(content=draft_prompt),
                            HumanMessage(content=f"{state['request']}\nFacts: {state['facts']}")])
        return {"plan": reply.content}

    def review(state):
        reply = llm.invoke([SystemMessage(content="Review the day plan against the facts. Flag incorrect units or budgets."),
                            HumanMessage(content=f"Facts: {state['facts']}\nPlan: {state['plan']}")])
        return {"review": reply.content}

    graph = StateGraph(Trip)
    for node in [research, draft, review]:
        graph.add_node(node.__name__, node)
    graph.add_edge(START, "research")
    graph.add_edge("research", "draft")
    graph.add_edge("draft", "review")
    graph.add_edge("review", END)
    result = graph.compile().invoke({"request": "Plan a day in Paris with a budget of 100 USD in EUR."})
    print(f"draft: {result['plan']}", flush=True)
    print(f"review: {result['review']}", flush=True)


if __name__ == "__main__":
    main()
