//evals.ts

import { EvalConfig } from 'mcp-evals';
import { openai } from "@ai-sdk/openai";
import { grade, EvalFunction } from "mcp-evals";

const searxng_web_searchEval: EvalFunction = {
    name: "searxng_web_search Tool Evaluation",
    description: "Evaluates searxng_web_search tool functionality",
    run: async () => {
        const result = await grade(openai("gpt-4o"), "Search for the latest news on climate change using the searxng_web_search tool and summarize the top findings.");
        return JSON.parse(result);
    }
};

const config: EvalConfig = {
    model: openai("gpt-4o"),
    evals: [searxng_web_searchEval ]
};
  
export default config;
  
export const evals = [searxng_web_searchEval ];