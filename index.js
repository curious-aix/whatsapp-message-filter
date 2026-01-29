const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_SHEETS_WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// System message types to ignore
const SYSTEM_MESSAGE_PATTERNS = [
  /^\u200e.*changed the group.*$/i,
  /^\u200e.*added you$/i,
  /^\u200e.*added.*$/i,
  /^\u200e.*removed.*$/i,
  /^\u200e.*left$/i,
  /^\u200e.*created group/i,
  /^Messages and calls are end-to-end encrypted/i,
  /^Waiting for this message/i,
  /^This message was deleted/i,
  /^You deleted this message/i,
  /^null$/i,
  /^\s*$/
];

function isSystemMessage(body) {
  if (!body || body.trim() === '') return true;
  return SYSTEM_MESSAGE_PATTERNS.some(pattern => pattern.test(body));
}

async function classifyWithGPT(message, sourceName) {
  const prompt = `Analyze this WhatsApp message from "${sourceName}". Is it an action item (task, question, request, pricing discussion, commitment, needs follow-up)? If yes, extract: responsible person (name or "Unknown"), urgency (Urgent/Normal/Low), due date if mentioned (or "None"), one-line summary.

Message: "${message}"

Return ONLY valid JSON: {"isActionItem": boolean, "responsible": "string", "urgency": "string", "due": "string", "summary": "string"}`;

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 200
    }, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const content = response.data.choices[0].message.content.trim();
    // Extract JSON from potential markdown code blocks
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { isActionItem: false };
  } catch (error) {
    console.error('GPT classification error:', error.response?.data || error.message);
    return { isActionItem: false };
  }
}

async function writeToGoogleSheets(data) {
  try {
    const response = await axios.post(GOOGLE_SHEETS_WEBHOOK_URL, data, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('Written to Google Sheets:', response.data);
    return true;
  } catch (error) {
    console.error('Google Sheets error:', error.response?.data || error.message);
    return false;
  }
}

app.post('/webhook', async (req, res) => {
  console.log('Received webhook:', JSON.stringify(req.body, null, 2));
  
  try {
    const payload = req.body;
    
    // Handle different Waha webhook formats
    const event = payload.event || 'message';
    
    // Skip non-message events
    if (!event.includes('message')) {
      console.log('Skipping non-message event:', event);
      return res.json({ status: 'skipped', reason: 'non-message event' });
    }
    
    // Extract message data - handle both direct and nested formats
    const messageData = payload.payload || payload;
    const body = messageData.body || messageData.text || messageData.caption || '';
    const fromMe = messageData.fromMe || messageData.from_me || false;
    
    // Skip outgoing messages
    if (fromMe) {
      console.log('Skipping outgoing message');
      return res.json({ status: 'skipped', reason: 'outgoing message' });
    }
    
    // Skip system messages and empty content
    if (isSystemMessage(body)) {
      console.log('Skipping system/empty message');
      return res.json({ status: 'skipped', reason: 'system or empty message' });
    }
    
    // Get source info
    const chatId = messageData.chatId || messageData.from || messageData.chat?.id || '';
    const sourceName = messageData._data?.notifyName || 
                       messageData.notifyName || 
                       messageData.pushName ||
                       messageData.chat?.name ||
                       chatId.split('@')[0] || 
                       'Unknown';
    
    console.log(`Processing message from ${sourceName}: ${body.substring(0, 100)}...`);
    
    // Classify with GPT
    const classification = await classifyWithGPT(body, sourceName);
    console.log('Classification result:', classification);
    
    if (classification.isActionItem) {
      // Write to Google Sheets
      const sheetData = {
        timestamp: new Date().toISOString(),
        source: sourceName,
        message: body,
        responsible: classification.responsible || 'Unknown',
        urgency: classification.urgency || 'Normal',
        due: classification.due || 'None',
        status: 'Open',
        chatId: chatId
      };
      
      await writeToGoogleSheets(sheetData);
      console.log('Action item written to sheets');
      
      return res.json({ 
        status: 'processed', 
        isActionItem: true,
        classification 
      });
    }
    
    return res.json({ 
      status: 'processed', 
      isActionItem: false 
    });
    
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    service: 'WhatsApp Message Filter',
    endpoints: {
      webhook: 'POST /webhook',
      health: 'GET /health'
    }
  });
});

app.listen(PORT, () => {
  console.log(`WhatsApp Filter Service running on port ${PORT}`);
});
