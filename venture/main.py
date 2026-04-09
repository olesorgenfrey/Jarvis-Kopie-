import re
import json
import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST"],
    allow_headers=["*"],
)

client = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

PROMPT_TEMPLATE = """Du bist ein präziser Business-Analyst. Analysiere diese Geschäftsidee und antworte NUR mit reinem JSON, ohne Markdown, ohne Backticks, ohne Text davor oder danach.

Idee: {idea}

JSON-Format:
{{
  "zusammenfassung": "2-3 Sätze was die Idee ist",
  "konkurrenten": [
    {{ "name": "Firmenname", "was": "Was sie machen", "preis": "Preismodell", "schwaeche": "Konkrete Schwäche" }}
  ],
  "markt": {{
    "groesse": "Geschätzte Marktgröße mit Basis",
    "wachstum": "Wachstumsrate und Trend",
    "nachfrage": "Konkrete Nachfragesignale (Suchanfragen, Foren, etc.)"
  }},
  "risiko": {{
    "level": "hoch",
    "score": 65,
    "gruende": ["Grund 1", "Grund 2", "Grund 3"],
    "chancen": ["Chance 1", "Chance 2"]
  }},
  "naechster_schritt": "Ein konkreter sofort umsetzbarer nächster Schritt diese Woche"
}}

Wichtig: level muss exakt einer dieser Werte sein: hoch, mittel, niedrig.
Sei konkret, echte Firmennamen, echte Zahlen. Keine Floskeln."""


class IdeaRequest(BaseModel):
    idea: str


@app.post("/analyze")
async def analyze(request: IdeaRequest):
    if not request.idea.strip():
        raise HTTPException(status_code=400, detail="Keine Idee angegeben")

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY nicht gesetzt")

    try:
        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1500,
            messages=[
                {"role": "user", "content": PROMPT_TEMPLATE.format(idea=request.idea)}
            ],
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Claude API Fehler: {str(e)}")

    raw = message.content[0].text

    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise HTTPException(status_code=500, detail="Kein JSON in Claude-Antwort gefunden")

    try:
        result = json.loads(match.group())
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"JSON-Parsing fehlgeschlagen: {str(e)}")

    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
