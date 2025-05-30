#!/usr/bin/env node

/**
 * Test Claude Desktop MCP Server
 */

const { spawn } = require('child_process');
const path = require('path');

async function testClaudeMCPServer() {
  console.log('🚀 Testing Claude Desktop MCP Server\n');
  
  const serverPath = path.join(__dirname, 'src', 'mcp-server-claude.js');
  console.log(`Starting: ${serverPath}\n`);
  
  const server = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  let responses = [];
  
  server.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          responses.push(response);
          console.log('✅ Response:', JSON.stringify(response, null, 2));
        } catch (e) {
          console.log('📄 Output:', line);
        }
      }
    });
  });
  
  server.stderr.on('data', (data) => {
    console.log('📝 Log:', data.toString().trim());
  });

  // Test messages
  const tests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'Test Client', version: '1.0.0' }
      }
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_malaysian_prices',
        arguments: { query: 'rice prices in KL' }
      }
    }
  ];

  // Send test messages with delays
  for (let i = 0; i < tests.length; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log(`\n📤 Sending test ${i + 1}:`, JSON.stringify(tests[i]));
    server.stdin.write(JSON.stringify(tests[i]) + '\n');
  }

  // Wait for responses
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  console.log(`\n📊 Summary: Received ${responses.length} responses`);
  
  server.kill();
  console.log('\n🎉 Test completed!');
}

testClaudeMCPServer().catch(console.error);