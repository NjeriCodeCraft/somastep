require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: (process.env.GEMINI_API_KEY || '').trim() });

const prompt = `You are SomaStep, a warm and encouraging tutor on a phone call with a Grade 5 child called Lee in Kenya.
Teach ONE small idea from Science: why plants need sunlight.
Reply ONLY with JSON, no markdown, in exactly this shape:
{"teach": "2 to 3 short sentences explaining the idea", "question": "one simple question to check understanding", "answer": "the correct answer in a few words"}
Keep teach plus question under 45 words in total.`;

async function run() {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt
  });
  const raw = response.text.replace(/```json|```/g, '').trim();
  console.log('RAW:', raw);
  const turn = JSON.parse(raw);
  console.log('Parsed OK. Teach:', turn.teach);
  console.log('Question:', turn.question);
}

run().catch((e) => console.log('FAILED:', e.message));