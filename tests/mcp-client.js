#!/usr/bin/env node

/**
 * MCP Client for ManaMurah Server
 * Connects to remote ManaMurah MCP server deployed on Cloudflare Workers
 */

const { spawn } = require('child_process');

// Simple EventSource polyfill for Node.js
class SimpleEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
  }
  
  async connect() {
    try {
      const response = await fetch(this.url, {
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache'
        }
      });
      
      if (response.ok) {
        this.readyState = 1; // OPEN
        if (this.onopen) this.onopen();
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (this.onmessage) {
                this.onmessage({ data });
              }
            }
          }
        }
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      this.readyState = 2; // CLOSED
      if (this.onerror) this.onerror(error);
    }
  }
  
  close() {
    this.readyState = 2; // CLOSED
  }
}

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'https://manamurah-mcp-server.agagroup.workers.dev/sse';

/**
 * MCP Client that bridges Claude Desktop to remote MCP server
 */
class ManaMurahMCPClient {
  constructor() {
    this.serverUrl = MCP_SERVER_URL;
    this.eventSource = null;
  }

  async connect() {
    console.error(`[MCP Client] Connecting to ${this.serverUrl}`);
    
    try {
      // Create EventSource connection to SSE endpoint
      this.eventSource = new SimpleEventSource(this.serverUrl);
      
      this.eventSource.onopen = () => {
        console.error('[MCP Client] Connected to ManaMurah MCP Server');
      };

      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Forward MCP messages to Claude Desktop via stdout
          process.stdout.write(JSON.stringify(data) + '\n');
        } catch (error) {
          console.error('[MCP Client] Error parsing message:', error);
        }
      };

      this.eventSource.onerror = (error) => {
        console.error('[MCP Client] SSE Error:', error);
      };
      
      // Start connection
      this.eventSource.connect();

      // Handle stdin from Claude Desktop
      process.stdin.on('data', async (data) => {
        try {
          const message = JSON.parse(data.toString().trim());
          await this.sendToServer(message);
        } catch (error) {
          console.error('[MCP Client] Error processing stdin:', error);
        }
      });

      process.stdin.on('end', () => {
        this.disconnect();
      });

    } catch (error) {
      console.error('[MCP Client] Connection failed:', error);
      process.exit(1);
    }
  }

  async sendToServer(message) {
    try {
      const response = await fetch(`${this.serverUrl.replace('/sse', '/mcp')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });

      const result = await response.json();
      
      // Send response back to Claude Desktop
      process.stdout.write(JSON.stringify(result) + '\n');
      
    } catch (error) {
      console.error('[MCP Client] Error sending to server:', error);
      
      // Send error response back to Claude Desktop
      const errorResponse = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: error.message
        }
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  }

  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      console.error('[MCP Client] Disconnected from ManaMurah MCP Server');
    }
  }
}

// Start MCP client
const client = new ManaMurahMCPClient();
client.connect().catch(error => {
  console.error('[MCP Client] Fatal error:', error);
  process.exit(1);
});

// Handle process termination
process.on('SIGINT', () => {
  client.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  client.disconnect();
  process.exit(0);
});