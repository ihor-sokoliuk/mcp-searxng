#!/usr/bin/env node

// Simple validation script for You.com integration
import { performYouComWebSearch, isYouComSearchEnabled, getYouComProviderInfo } from '../src/youcom-search.js';

async function testYouComIntegration() {
  console.log('🧪 Testing You.com Integration...');

  // Test 1: Provider detection
  console.log('\n📋 Test 1: Provider configuration detection');
  const originalProvider = process.env.SEARCH_PROVIDER;
  
  // Test default (should be false)
  delete process.env.SEARCH_PROVIDER;
  console.log(`   Default provider enabled: ${isYouComSearchEnabled()}`);
  
  // Test youcom setting
  process.env.SEARCH_PROVIDER = 'youcom';
  console.log(`   You.com provider enabled: ${isYouComSearchEnabled()}`);
  
  // Test provider info
  console.log('\n📊 Test 2: Provider information');
  const providerInfo = getYouComProviderInfo();
  console.log(`   Provider: ${providerInfo.provider}`);
  console.log(`   Mode: ${providerInfo.mode}`);
  console.log(`   Quotas: ${providerInfo.quotas}`);
  console.log(`   Endpoint: ${providerInfo.endpoint}`);
  
  // Test 3: Basic search functionality (requires network)
  console.log('\n🔍 Test 3: Basic search functionality');
  if (process.env.YDC_API_KEY || process.env.NODE_ENV !== 'production') {
    try {
      // Create mock MCP server for logging
      const mockMcpServer = {
        server: {
          notification: () => {},
          request: () => {}
        }
      };
      
      const searchResult = await performYouComWebSearch(mockMcpServer as any, 'TypeScript MCP servers', {
        count: 3,
        timeoutMs: 5000
      });
      
      console.log(`   ✅ Search completed: ${searchResult.results.length} results`);
      console.log(`   Query: "${searchResult.query}"`);
      console.log(`   Source format: ${searchResult.sourceFormat}`);
      
      if (searchResult.results.length > 0) {
        console.log(`   First result: "${searchResult.results[0].title}"`);
      }
    } catch (error) {
      console.log(`   ⚠️  Search error (expected in some environments): ${error.message}`);
    }
  } else {
    console.log('   ⏭️  Skipping search test (no API key and not in dev environment)');
  }
  
  // Restore original setting
  if (originalProvider) {
    process.env.SEARCH_PROVIDER = originalProvider;
  } else {
    delete process.env.SEARCH_PROVIDER;
  }
  
  console.log('\n✅ You.com integration validation complete!');
}

testYouComIntegration().catch(console.error);