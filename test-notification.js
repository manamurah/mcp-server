#!/usr/bin/env node

/**
 * Test notification handling in MCP server
 */

const { spawn } = require('child_process');

const testMessages = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "test-client", version: "1.0.0" }
    }
  },
  {
    jsonrpc: "2.0",
    method: "notifications/initialized"
  },
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list"
  },
  {
    jsonrpc: "2.0",
    id: 3,
    method: "resources/list"
  }
];

async function testNotifications() {
  console.log('Testing notification handling...\n');
  
  const mcpServer = spawn('node', ['src/mcp-server-claude.js'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  mcpServer.stderr.on('data', (data) => {
    console.log('Server log:', data.toString().trim());
  });

  await new Promise(resolve => setTimeout(resolve, 1000));

  for (let i = 0; i < testMessages.length; i++) {
    const message = testMessages[i];
    console.log(`\n--- Test ${i + 1}: ${message.method} ---`);
    
    mcpServer.stdin.write(JSON.stringify(message) + '\n');
    
    // For notifications, we don't expect a response
    if (message.method.startsWith('notifications/')) {
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('Notification sent (no response expected)');
    } else {
      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          console.log('Timeout waiting for response');
          resolve();
        }, 3000);
        
        mcpServer.stdout.once('data', (data) => {
          clearTimeout(timeout);
          console.log('Response:', data.toString().trim());
          resolve();
        });
      });
    }
  }

  console.log('\n--- Test Complete ---');
  mcpServer.kill();
}

testNotifications().catch(console.error);