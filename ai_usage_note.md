# AI Usage Note

## Model Details
This prototype utilizes the **Llama-3.3-70b** model hosted via the **Groq Cloud API** to perform automated ticket quality auditing. 

## Prompt Engineering Strategy
We implemented custom system prompts to instruct the LLM to score incoming support tickets based on clarity, tone, and resolution accuracy. The model evaluates tickets on a defined scale and outputs structured JSON analysis.