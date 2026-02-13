// server.js
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cloud cache (shared across all users)
const CACHE = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    cached_questions: CACHE.size,
    timestamp: new Date().toISOString()
  });
});

// AI endpoint
app.post('/ai', async (req, res) => {
  try {
    const question = req.body.question?.trim();
    
    // Validate input
    if (!question || question.length < 3) {
      return res.status(400).json({ error: "Please enter a complete question (minimum 3 characters)" });
    }

    // Block personal health queries
    const unsafePatterns = [
      /my (symptom|pain|condition|diagnosis|chest|headache|fever|cough|rash)/i,
      /should i take/i, /what dose/i, /prescribe/i, /diagnose me/i,
      /treat my/i, /am i having/i, /is this serious/i, /help me/i
    ];
    
    if (unsafePatterns.some(pattern => pattern.test(question))) {
      return res.status(400).json({ 
        error: "Educational questions only. Rephrase (e.g., 'What causes chest pain in MI?')" 
      });
    }

    // Normalize question for cache key
    const cacheKey = question
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_{2,}/g, '_')
      .slice(0, 100);

    // ✅ CHECK CACHE FIRST (saves API quota)
    if (CACHE.has(cacheKey)) {
      console.log(`✅ Cache hit: "${question}"`);
      return res.json({ 
        answer: CACHE.get(cacheKey), 
        source: "cloud_cache",
        cached: true
      });
    }

    // ❌ CACHE MISS → Call Gemini API
    console.log(`🔄 Cache miss: "${question}" - calling Gemini...`);
    
    const GEMINI_KEY = process.env.GEMINI_KEY;
    if (!GEMINI_KEY) {
      return res.status(500).json({ 
        error: "Backend not configured. Please set GEMINI_KEY environment variable." 
      });
    }

    const prompt = `You are an expert medical educator helping students prepare for exams. Provide a concise, accurate educational explanation:

"${question}"

RULES:
1. ONLY provide general medical knowledge for exam preparation
2. NEVER give personal medical advice, diagnosis, or treatment recommendations
3. Include key pathophysiology/mechanisms when relevant
4. Keep response under 200 words
5. End with: "For actual patient care, always consult a physician."

Response:`;

    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { 
          temperature: 0.3, 
          maxOutputTokens: 800,
          topP: 0.95
        },
        safetySettings: [
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
        ]
      },
      { timeout: 10000 } // 10 second timeout
    );

    // Extract answer
    const candidate = geminiResponse.data.candidates?.[0];
    if (!candidate || candidate.finishReason === "SAFETY") {
      return res.status(400).json({ 
        error: "Question blocked by safety filters. Ask strictly educational questions." 
      });
    }

    const answer = candidate.content?.parts?.[0]?.text?.trim();
    if (!answer || answer.length < 15) {
      return res.status(500).json({ error: "Empty response from AI. Try rephrasing." });
    }

    // ✅ CACHE FOR ALL FUTURE USERS
    CACHE.set(cacheKey, answer);
    
    // Keep cache size reasonable (last 1,000 questions)
    if (CACHE.size > 1000) {
      const firstKey = CACHE.keys().next().value;
      CACHE.delete(firstKey);
    }

    console.log(`✅ Cached: "${question}" | Total cached: ${CACHE.size}`);
    
    res.json({ 
      answer, 
      source: "gemini_2.5_flash",
      cached: false,
      cache_size: CACHE.size
    });

  } catch (error) {
    console.error("❌ Backend error:", error.message);
    
    // Handle quota errors gracefully
    if (error.response?.data?.error?.message?.includes('quota')) {
      return res.status(429).json({ 
        error: "Daily AI quota exceeded. Cached answers still available. Try again tomorrow.",
        quota_exceeded: true
      });
    }
    
    res.status(500).json({ 
      error: "AI temporarily unavailable. Try again in a few minutes.",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Medical AI Backend running on port ${PORT}`);
  console.log(`📊 Cache: ${CACHE.size} questions`);
});