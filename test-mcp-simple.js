#!/usr/bin/env node

/**
 * Simple MCP Server Test
 * Quick test of the ManaMurah MCP Server functionality
 */

const MCP_SERVER_URL = 'https://manamurah-mcp-server.agagroup.workers.dev';

async function testMCPServer() {
  console.log('🚀 Testing ManaMurah MCP Server\n');
  
  // Test 1: Server Info
  console.log('1. Testing server info...');
  try {
    const response = await fetch(`${MCP_SERVER_URL}/`);
    const data = await response.json();
    console.log(`✅ Server operational: ${data.name} v${data.version}`);
    console.log(`📊 Available tools: ${data.tools.length}`);
  } catch (error) {
    console.log('❌ Server info failed:', error.message);
    return;
  }
  
  // Test 2: Tools List
  console.log('\n2. Testing tools list...');
  try {
    const response = await fetch(`${MCP_SERVER_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      })
    });
    const data = await response.json();
    console.log(`✅ Found ${data.result.tools.length} tools:`);
    data.result.tools.forEach(tool => {
      console.log(`   • ${tool.name}: ${tool.description}`);
    });
  } catch (error) {
    console.log('❌ Tools list failed:', error.message);
    return;
  }
  
  // Test 3: Price Search
  console.log('\n3. Testing price search...');
  try {
    const response = await fetch(`${MCP_SERVER_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'get_malaysian_prices',
          arguments: {
            query: 'rice prices in Kuala Lumpur'
          }
        }
      })
    });
    const data = await response.json();
    if (data.result && data.result.content) {
      console.log('✅ Price search successful');
      const text = data.result.content[0].text;
      console.log('📊 Response preview:', text.substring(0, 150) + '...');
    } else {
      console.log('❌ Price search failed:', data.error?.message);
    }
  } catch (error) {
    console.log('❌ Price search failed:', error.message);
  }
  
  // Test 4: SSE Endpoint
  console.log('\n4. Testing SSE endpoint...');
  try {
    const response = await fetch(`${MCP_SERVER_URL}/sse`, {
      headers: { 'Accept': 'text/event-stream' }
    });
    console.log(`✅ SSE endpoint accessible (${response.status})`);
    console.log(`📊 Content-Type: ${response.headers.get('content-type')}`);
  } catch (error) {
    console.log('❌ SSE endpoint failed:', error.message);
  }
  
  console.log('\n🎉 MCP Server test completed!');
  console.log('\n📝 Claude Desktop Setup:');
  console.log('Add this to your Claude Desktop MCP configuration:');
  console.log(`
{
  "manamurah": {
    "command": "node",
    "args": ["${process.cwd()}/tests/mcp-client.js"],
    "env": {
      "MCP_SERVER_URL": "${MCP_SERVER_URL}/sse"
    }
  }
}`);
}

// Run the test
testMCPServer().catch(console.error);