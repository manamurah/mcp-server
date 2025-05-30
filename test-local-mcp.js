#!/usr/bin/env node

/**
 * Test Local MCP Server
 * Tests the local MCP server that Claude Desktop will use
 */

const { spawn } = require('child_process');
const path = require('path');

async function testLocalMCPServer() {
  console.log('🚀 Testing Local MCP Server for Claude Desktop\n');
  
  const serverPath = path.join(__dirname, 'src', 'local-mcp-server.js');
  
  console.log(`Starting server: ${serverPath}`);
  
  const server = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  let responses = [];
  
  // Collect responses
  server.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => {
      if (line.trim()) {
        try {
          responses.push(JSON.parse(line));
        } catch (e) {
          console.log('Non-JSON output:', line);
        }
      }
    });
  });
  
  // Log server errors
  server.stderr.on('data', (data) => {
    console.log('Server log:', data.toString().trim());
  });
  
  // Test sequence
  const tests = [
    {
      name: 'Initialize',
      message: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'Claude Desktop',
            version: '1.0.0'
          }
        }
      }
    },
    {
      name: 'List Tools',
      message: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
      }
    },
    {
      name: 'Call Price Search Tool',
      message: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'get_malaysian_prices',
          arguments: {
            query: 'rice prices in Kuala Lumpur'
          }
        }
      }
    }
  ];
  
  // Send test messages
  for (const test of tests) {
    console.log(`\n📤 Testing: ${test.name}`);
    server.stdin.write(JSON.stringify(test.message) + '\n');
    
    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Give time for all responses
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Analyze responses
  console.log('\n📥 Test Results:');
  responses.forEach((response, index) => {
    console.log(`\n${index + 1}. Response ID ${response.id}:`);
    if (response.result) {
      if (response.result.tools) {
        console.log(`   ✅ Tools listed: ${response.result.tools.length}`);
      } else if (response.result.content) {
        console.log(`   ✅ Tool executed successfully`);
        console.log(`   📊 Response preview: ${response.result.content[0].text.substring(0, 100)}...`);
      } else if (response.result.protocolVersion) {
        console.log(`   ✅ Initialized with protocol ${response.result.protocolVersion}`);
      } else {
        console.log(`   ✅ Success:`, response.result);
      }
    } else if (response.error) {
      console.log(`   ❌ Error: ${response.error.message}`);
    }
  });
  
  // Cleanup
  server.kill();
  
  console.log('\n🎉 Local MCP Server test completed!');
  console.log('\n📝 Claude Desktop Configuration:');
  console.log('Add this to your Claude Desktop MCP configuration:');
  console.log(`
{
  "manamurah": {
    "command": "node",
    "args": ["${serverPath}"]
  }
}`);
}

testLocalMCPServer().catch(console.error);