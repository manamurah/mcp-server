#!/usr/bin/env node

/**
 * Test script for local MCP server
 * Tests the MCP protocol implementation
 */

const { spawn } = require('child_process');

// Test messages to send to MCP server
const testMessages = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {}
      },
      clientInfo: {
        name: "test-client",
        version: "1.0.0"
      }
    }
  },
  {
    jsonrpc: "2.0", 
    id: 2,
    method: "tools/list"
  },
  {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "get_malaysian_prices",
      arguments: {
        query: "rice prices in Kuala Lumpur"
      }
    }
  }
];

async function testMCPServer() {
  console.log('Starting MCP server test...\n');
  
  // Spawn the MCP server
  const mcpServer = spawn('node', ['src/mcp-server-claude.js'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  mcpServer.stderr.on('data', (data) => {
    console.log('Server log:', data.toString().trim());
  });

  // Wait a moment for server to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Send test messages one by one
  for (let i = 0; i < testMessages.length; i++) {
    const message = testMessages[i];
    console.log(`\n--- Test ${i + 1}: ${message.method} ---`);
    console.log('Sending:', JSON.stringify(message, null, 2));
    
    // Send message to server
    mcpServer.stdin.write(JSON.stringify(message) + '\n');
    
    // Wait for response
    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        console.log('Timeout waiting for response');
        resolve();
      }, 5000);
      
      mcpServer.stdout.once('data', (data) => {
        clearTimeout(timeout);
        console.log('Response:', data.toString().trim());
        resolve();
      });
    });
  }

  console.log('\n--- Test Complete ---');
  mcpServer.kill();
}

testMCPServer().catch(console.error);