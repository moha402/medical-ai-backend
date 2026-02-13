// server.js
// ✅ FIXED: Gemini URL spacing errors
// ✅ ADDED: Hugging Face fallback when Gemini fails
// ✅ FEATURES: Intelligent fallback chain + shared cloud cache

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors({
  origin: '*', // Allow all origins (restrict in production)
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
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

// ===== HUGGING FACE FALLBACK FUNCTION =====
async function queryHuggingFace(question) {
  const HF_API_KEY = process.env.HUGGINGFACE_API_KEY;
  if (!HF_API_KEY) {
    console.warn("⚠️ Hugging Face API key not configured");
    return null;
  }
  
  const prompt = `[INST] You are an expert medical educator. Provide a concise educational explanation for exam preparation only.

Question: "${question}"

Rules:
- ONLY general medical knowledge for exams
- NEVER personal advice/diagnosis/treatment
- Include key pathophysiology when relevant
- Keep under 150 words
- End with: "For actual patient care, always consult a physician."

Answer: [/INST]`;
  
  try {
    const response = await axios.post(
      'https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2',
      {
        inputs: prompt,
        parameters: {
          max_new_tokens: 350,
          temperature: 0.3,
          top_p: 0.95,
          return_full_text: false,
          stop: ["[/INST]", "Question:", "Rules:"]
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${HF_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000 // 25 second timeout
      }
    );
    
    // Parse Mistral response
    let answer = "";
    if (Array.isArray(response.data) && response.data[0]?.generated_text) {
      answer = response.data[0].generated_text;
    } else if (response.data?.generated_text) {
      answer = response.data.generated_text;
    } else {
      console.warn("Unexpected Hugging Face response format:", response.data);
      return null;
    }
    
    answer = answer.trim();
    
    // Clean up Mistral artifacts
    answer = answer
      .replace(/\[\/INST\].*/s, '')
      .replace(/\[INST\].*?\[\/INST\]/gs, '')
      .replace(/^(Answer:|Response:)\s*/i, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    
    // Ensure educational ending
    if (answer && !answer.toLowerCase().includes("consult a physician")) {
      answer += "\n\nFor actual patient care, always consult a physician.";
    }
    
    if (!answer || answer.length < 20) {
      console.warn("Hugging Face returned empty or too short response");
      return null;
    }
    
    return answer;
    
  } catch (error) {
    // Handle model loading state
    if (error.response?.status === 503) {
      const data = error.response?.data || {};
      if (data.estimated_time) {
        console.warn(`Hugging Face model loading - estimated ${Math.ceil(data.estimated_time)} seconds`);
      }
      console.warn("Hugging Face model loading - will retry later");
      return null;
    }
    
    // Handle auth errors
    if (error.response?.status === 401) {
      console.error("❌ Invalid Hugging Face API key");
      return null;
    }
    
    console.warn("Hugging Face error:", error.message);
    return null;
  }
}

// AI endpoint with Gemini → Hugging Face fallback
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

    // ❌ CACHE MISS → Try Gemini FIRST
    console.log(`🔄 Cache miss: "${question}" - trying Gemini...`);
    
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

    // ✅ FIXED: NO SPACES before colon in URL
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
    
    try {
      const geminiResponse = await axios.post(
        geminiUrl,
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
        throw new Error("Blocked by safety filters");
      }

      const answer = candidate.content?.parts?.[0]?.text?.trim();
      if (!answer || answer.length < 15) {
        throw new Error("Empty response");
      }

      // ✅ CACHE FOR ALL FUTURE USERS
      CACHE.set(cacheKey, answer);
      
      // Keep cache size reasonable (last 1,000 questions)
      if (CACHE.size > 1000) {
        const firstKey = CACHE.keys().next().value;
        CACHE.delete(firstKey);
      }

      console.log(`✅ Cached from Gemini: "${question}" | Total cached: ${CACHE.size}`);
      
      return res.json({ 
        answer, 
        source: "gemini_2.5_flash",
        cached: false,
        cache_size: CACHE.size
      });
      
    } catch (geminiError) {
      // ✅ Gemini failed → Try Hugging Face as fallback
      console.warn("⚠️ Gemini failed:", geminiError.message);
      
      // Handle quota errors specifically
      if (geminiError.response?.data?.error?.message?.includes('quota') || 
          geminiError.response?.status === 429) {
        console.log(`🔄 Quota exceeded - trying Hugging Face fallback for: "${question}"`);
      } else {
        console.log(`🔄 Gemini error - trying Hugging Face fallback for: "${question}"`);
      }
      
      const hfAnswer = await queryHuggingFace(question);
      
      if (hfAnswer) {
        // ✅ CACHE Hugging Face answer
        CACHE.set(cacheKey, hfAnswer);
        if (CACHE.size > 1000) {
          const firstKey = CACHE.keys().next().value;
          CACHE.delete(firstKey);
        }
        
        console.log(`✅ Cached from Hugging Face: "${question}" | Total cached: ${CACHE.size}`);
        
        return res.json({ 
          answer: hfAnswer, 
          source: "huggingface_mistral",
          cached: false,
          cache_size: CACHE.size
        });
      }
      
      // ❌ Both failed → Return error
      console.error("❌ Both Gemini and Hugging Face failed for:", question);
      
      // Check if it's a quota error
      if (geminiError.response?.data?.error?.message?.includes('quota') || 
          geminiError.response?.status === 429) {
        return res.status(429).json({ 
          error: "Daily AI quota exceeded. Cached answers still available. Try again tomorrow.",
          quota_exceeded: true
        });
      }
      
      return res.status(500).json({ 
        error: "AI temporarily unavailable. Try cached questions or common topics.",
        details: "Both Gemini and Hugging Face failed"
      });
    }

  } catch (error) {
    console.error("❌ Backend error:", error.message);
    console.error("❌ Error details:", error.response?.data || error.config?.url || error.stack);
    
    res.status(500).json({ 
      error: "AI temporarily unavailable. Try again in a few minutes.",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Medical AI Backend v2.0 running on port ${PORT}`);
  console.log(`📊 Cache initialized with ${CACHE.size} questions`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`✨ Features: Gemini + Hugging Face fallback | Shared cloud cache`);
});
