// backend/gemini_test.js (ahora usando Groq en vez de Gemini)
import dotenv from "dotenv";
import Groq from "groq-sdk";

dotenv.config();

async function testGroq() {
  try {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      throw new Error("Falta GROQ_API_KEY en tu archivo .env");
    }

    const groq = new Groq({ apiKey });

    console.log("🔎 Probando Groq (LLaMA 3 8B)...");

    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant", // uno de los modelos rápidos
      messages: [
        {
          role: "system",
          content:
            "Eres un asistente que responde en español de forma clara y breve.",
        },
        {
          role: "user",
          content:
            "Explícame en una sola frase qué es la desinformación y por qué es peligrosa.",
        },
      ],
      temperature: 0.3,
      max_tokens: 150,
    });

    const text = response.choices?.[0]?.message?.content ?? "";
    console.log("\n✅ Respuesta de Groq:\n");
    console.log(text);
  } catch (err) {
    console.error("❌ Error al llamar a Groq:", err);
  }
}

testGroq();
