/**\n * Test script for ManaMurah MCP Server\n * Tests the deployed MCP server functionality\n */\n\nconst MCP_SERVER_URL = 'https://mcp.manamurah.com';\n\n/**\n * Test basic MCP server connectivity\n */\nasync function testServerConnectivity() {\n  console.log('🔍 Testing MCP Server Connectivity...');\n  \n  try {\n    const response = await fetch(`${MCP_SERVER_URL}/mcp`, {\n      method: 'POST',\n      headers: {\n        'Content-Type': 'application/json'\n      },\n      body: JSON.stringify({\n        jsonrpc: '2.0',\n        id: 1,\n        method: 'tools/list'\n      })\n    });\n\n    const data = await response.json();\n    \n    if (data.result && data.result.tools) {\n      console.log('✅ Server connectivity successful');\n      console.log(`📊 Found ${data.result.tools.length} available tools:`);\n      data.result.tools.forEach(tool => {\n        console.log(`   • ${tool.name}: ${tool.description}`);\n      });\n      return true;\n    } else {\n      console.log('❌ Server responded but no tools found');\n      return false;\n    }\n  } catch (error) {\n    console.log('❌ Server connectivity failed:', error.message);\n    return false;\n  }\n}\n\n/**\n * Test price search tool\n */\nasync function testPriceSearch() {\n  console.log('\\n🔍 Testing Price Search Tool...');\n  \n  const testQueries = [\n    { query: 'rice prices in Kuala Lumpur' },\n    { item: 'chicken', location: 'Penang' },\n    { query: 'cheapest cooking oil in Selangor' }\n  ];\n\n  for (const testQuery of testQueries) {\n    try {\n      console.log(`Testing query: ${JSON.stringify(testQuery)}`);\n      \n      const response = await fetch(`${MCP_SERVER_URL}/mcp`, {\n        method: 'POST',\n        headers: {\n          'Content-Type': 'application/json'\n        },\n        body: JSON.stringify({\n          jsonrpc: '2.0',\n          id: 1,\n          method: 'tools/call',\n          params: {\n            name: 'get_malaysian_prices',\n            arguments: testQuery\n          }\n        })\n      });\n\n      const data = await response.json();\n      \n      if (data.result && data.result.content) {\n        console.log('✅ Price search successful');\n        const responseText = data.result.content[0].text;\n        console.log('📊 Response preview:', responseText.substring(0, 200) + '...');\n      } else {\n        console.log('❌ Price search failed:', data.error?.message || 'Unknown error');\n      }\n      \n    } catch (error) {\n      console.log('❌ Price search error:', error.message);\n    }\n  }\n}\n\n/**\n * Test price comparison tool\n */\nasync function testPriceComparison() {\n  console.log('\\n🔍 Testing Price Comparison Tool...');\n  \n  try {\n    const response = await fetch(`${MCP_SERVER_URL}/mcp`, {\n      method: 'POST',\n      headers: {\n        'Content-Type': 'application/json'\n      },\n      body: JSON.stringify({\n        jsonrpc: '2.0',\n        id: 1,\n        method: 'tools/call',\n        params: {\n          name: 'compare_prices',\n          arguments: {\n            item: 'rice',\n            regions: ['Kuala Lumpur', 'Penang', 'Johor'],\n            comparison_type: 'states'\n          }\n        }\n      })\n    });\n\n    const data = await response.json();\n    \n    if (data.result && data.result.content) {\n      console.log('✅ Price comparison successful');\n      const responseText = data.result.content[0].text;\n      console.log('📊 Response preview:', responseText.substring(0, 200) + '...');\n    } else {\n      console.log('❌ Price comparison failed:', data.error?.message || 'Unknown error');\n    }\n    \n  } catch (error) {\n    console.log('❌ Price comparison error:', error.message);\n  }\n}\n\n/**\n * Test trend analysis tool\n */\nasync function testTrendAnalysis() {\n  console.log('\\n🔍 Testing Trend Analysis Tool...');\n  \n  try {\n    const response = await fetch(`${MCP_SERVER_URL}/mcp`, {\n      method: 'POST',\n      headers: {\n        'Content-Type': 'application/json'\n      },\n      body: JSON.stringify({\n        jsonrpc: '2.0',\n        id: 1,\n        method: 'tools/call',\n        params: {\n          name: 'analyze_price_trends',\n          arguments: {\n            items: ['rice', 'chicken'],\n            analysis_type: 'trend',\n            time_period: 'last_month'\n          }\n        }\n      })\n    });\n\n    const data = await response.json();\n    \n    if (data.result && data.result.content) {\n      console.log('✅ Trend analysis successful');\n      const responseText = data.result.content[0].text;\n      console.log('📊 Response preview:', responseText.substring(0, 200) + '...');\n    } else {\n      console.log('❌ Trend analysis failed:', data.error?.message || 'Unknown error');\n    }\n    \n  } catch (error) {\n    console.log('❌ Trend analysis error:', error.message);\n  }\n}\n\n/**\n * Test market insights tool\n */\nasync function testMarketInsights() {\n  console.log('\\n🔍 Testing Market Insights Tool...');\n  \n  try {\n    const response = await fetch(`${MCP_SERVER_URL}/mcp`, {\n      method: 'POST',\n      headers: {\n        'Content-Type': 'application/json'\n      },\n      body: JSON.stringify({\n        jsonrpc: '2.0',\n        id: 1,\n        method: 'tools/call',\n        params: {\n          name: 'get_market_insights',\n          arguments: {\n            focus: 'overview',\n            timeframe: 'this_week'\n          }\n        }\n      })\n    });\n\n    const data = await response.json();\n    \n    if (data.result && data.result.content) {\n      console.log('✅ Market insights successful');\n      const responseText = data.result.content[0].text;\n      console.log('📊 Response preview:', responseText.substring(0, 200) + '...');\n    } else {\n      console.log('❌ Market insights failed:', data.error?.message || 'Unknown error');\n    }\n    \n  } catch (error) {\n    console.log('❌ Market insights error:', error.message);\n  }\n}\n\n/**\n * Test rate limiting\n */\nasync function testRateLimiting() {\n  console.log('\\n🔍 Testing Rate Limiting...');\n  \n  const requests = [];\n  const maxRequests = 12; // Should exceed the 10/minute limit\n  \n  console.log(`Sending ${maxRequests} rapid requests to test rate limiting...`);\n  \n  for (let i = 0; i < maxRequests; i++) {\n    requests.push(\n      fetch(`${MCP_SERVER_URL}/mcp`, {\n        method: 'POST',\n        headers: {\n          'Content-Type': 'application/json'\n        },\n        body: JSON.stringify({\n          jsonrpc: '2.0',\n          id: i + 1,\n          method: 'tools/call',\n          params: {\n            name: 'get_malaysian_prices',\n            arguments: { query: `test query ${i + 1}` }\n          }\n        })\n      })\n    );\n  }\n  \n  try {\n    const responses = await Promise.all(requests);\n    const results = await Promise.all(responses.map(r => r.json()));\n    \n    const successful = results.filter(r => r.result).length;\n    const rateLimited = results.filter(r => r.error && r.error.message?.includes('rate limit')).length;\n    \n    console.log(`📊 Results: ${successful} successful, ${rateLimited} rate limited`);\n    \n    if (rateLimited > 0) {\n      console.log('✅ Rate limiting is working correctly');\n    } else {\n      console.log('⚠️  Rate limiting may not be working as expected');\n    }\n    \n  } catch (error) {\n    console.log('❌ Rate limiting test error:', error.message);\n  }\n}\n\n/**\n * Test SSE endpoint for Claude Desktop integration\n */\nasync function testSSEEndpoint() {\n  console.log('\\n🔍 Testing SSE Endpoint for Claude Desktop...');\n  \n  try {\n    const response = await fetch(`${MCP_SERVER_URL}/sse`, {\n      method: 'GET',\n      headers: {\n        'Accept': 'text/event-stream',\n        'Cache-Control': 'no-cache'\n      }\n    });\n\n    if (response.ok) {\n      console.log('✅ SSE endpoint accessible');\n      console.log(`📊 Response status: ${response.status}`);\n      console.log(`📊 Content-Type: ${response.headers.get('content-type')}`);\n    } else {\n      console.log('❌ SSE endpoint failed:', response.status, response.statusText);\n    }\n    \n  } catch (error) {\n    console.log('❌ SSE endpoint error:', error.message);\n  }\n}\n\n/**\n * Run all tests\n */\nasync function runAllTests() {\n  console.log('🚀 Starting ManaMurah MCP Server Tests\\n');\n  console.log(`Testing server: ${MCP_SERVER_URL}\\n`);\n  \n  // Update the URL above with your actual deployed URL before running tests\n  if (MCP_SERVER_URL.includes('your-account')) {\n    console.log('❌ Please update MCP_SERVER_URL with your actual deployed URL');\n    console.log('Example: https://manamurah-mcp-server.myaccount.workers.dev');\n    return;\n  }\n  \n  const connectivity = await testServerConnectivity();\n  \n  if (connectivity) {\n    await testPriceSearch();\n    await testPriceComparison();\n    await testTrendAnalysis();\n    await testMarketInsights();\n    await testRateLimiting();\n    await testSSEEndpoint();\n  }\n  \n  console.log('\\n🏁 Testing completed!');\n  console.log('\\n📝 Claude Desktop Setup:');\n  console.log('Add this to your Claude Desktop MCP configuration:');\n  console.log(`\\n{\n  \"manamurah\": {\n    \"command\": \"node\",\n    \"args\": [\"/path/to/mcp-client.js\"],\n    \"env\": {\n      \"MCP_SERVER_URL\": \"${MCP_SERVER_URL}/sse\"\n    }\n  }\n}`);\n}\n\n// Run tests if script is executed directly\nif (require.main === module) {\n  runAllTests().catch(console.error);\n}\n\nmodule.exports = {\n  testServerConnectivity,\n  testPriceSearch,\n  testPriceComparison,\n  testTrendAnalysis,\n  testMarketInsights,\n  testRateLimiting,\n  testSSEEndpoint,\n  runAllTests\n};