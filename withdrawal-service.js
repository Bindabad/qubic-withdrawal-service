/**
 * Qubic Withdrawal Service - Node.js Backend
 *
 * This service processes real blockchain withdrawals using the Qubic TypeScript library.
 * Deploy this to Railway.app, Render, or any Node.js hosting service.
 *
 * Installation:
 * npm install express @qubic-lib/qubic-ts-library @supabase/Bolt Database-js cors dotenv
 *
 * Environment Variables Required:
 * - TREASURY_WALLET_SEED: cdmdaqmuvoedlphmdedanqyvhmfabxthbzvzujdwgxucvatroguanro
 * - SUPABASE_URL: https://oeoocofmyzauwzbqmoyy.supabase.co
 * - SUPABASE_SERVICE_ROLE_KEY: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9lb29jb2ZteXphdXd6YnFtb3l5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MzkxNDAyNSwiZXhwIjoyMDc5NDkwMDI1fQ.LMBcKldMuRMESdW4hPDvFwxcqRNDcm3syr-Xwr8DxCc
 * - PORT: Port to run on (default: 3000)
 * - ALLOWED_ORIGINS: Comma-separated list of allowed origins (optional)
 */

const express = require('express');
const cors = require('cors');
const { QubicHelper, QubicTransaction, QubicPackageBuilder } = require('@qubic-lib/qubic-ts-library');
const { createClient } = require('@supabase/Bolt Database-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const TREASURY_SEED = process.env.TREASURY_WALLET_SEED;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUBIC_RPC_URL = 'https://rpc.qubic.org/v1/';

// Validate configuration
if (!TREASURY_SEED || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing required environment variables!');
  console.error('Required: TREASURY_WALLET_SEED, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*'
}));

// Initialize Bolt Database client
const Bolt Database = createClient(SUPABASE_URL, SUPABASE_KEY);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Qubic Withdrawal Service',
    timestamp: new Date().toISOString()
  });
});

// Process withdrawal endpoint
app.post('/process-withdrawal', async (req, res) => {
  const startTime = Date.now();
  console.log('📥 Received withdrawal request:', req.body);

  try {
    const { withdrawalId } = req.body;

    if (!withdrawalId) {
      return res.status(400).json({
        success: false,
        error: 'Missing withdrawalId parameter'
      });
    }

    // Fetch withdrawal from database
    console.log('🔍 Fetching withdrawal:', withdrawalId);
    const { data: withdrawal, error: fetchError } = await Bolt Database
      .from('withdrawals')
      .select('*')
      .eq('id', withdrawalId)
      .single();

    if (fetchError || !withdrawal) {
      console.error('❌ Withdrawal not found:', fetchError);
      return res.status(404).json({
        success: false,
        error: 'Withdrawal not found'
      });
    }

    if (withdrawal.status !== 'pending') {
      console.log('⚠️ Withdrawal already processed:', withdrawal.status);
      return res.status(400).json({
        success: false,
        error: `Withdrawal already ${withdrawal.status}`
      });
    }

    // Validate treasury balance
    const { data: aiMined } = await Bolt Database
      .from('transactions')
      .select('amount')
      .eq('type', 'ai_mining');

    const totalAiMined = aiMined?.reduce((sum, t) => sum + (t.amount || 0), 0) || 0;
    const treasuryBalance = totalAiMined * 0.55;

    const { data: totalWithdrawn } = await Bolt Database
      .from('withdrawals')
      .select('amount')
      .eq('status', 'completed');

    const totalWithdrawalAmount = totalWithdrawn?.reduce((sum, w) => sum + (w.amount || 0), 0) || 0;
    const availableBalance = treasuryBalance - totalWithdrawalAmount;

    if (availableBalance < Number(withdrawal.amount)) {
      console.log('⚠️ Insufficient balance:', availableBalance, '<', withdrawal.amount);
      await Bolt Database
        .from('withdrawals')
        .update({ status: 'failed' })
        .eq('id', withdrawalId);

      return res.status(400).json({
        success: false,
        error: `Insufficient treasury balance. Available: ${availableBalance.toLocaleString()} QUBIC`
      });
    }

    // Get current tick from Qubic network
    console.log('⏰ Fetching current tick...');
    const tickResponse = await fetch(`${QUBIC_RPC_URL}status`);
    const tickData = await tickResponse.json();
    const currentTick = tickData.lastProcessedTick?.tickNumber || 0;
    const targetTick = currentTick + 20;

    console.log(`📊 Current tick: ${currentTick}, Target tick: ${targetTick}`);

    // Create transaction
    console.log('🔐 Creating and signing transaction...');
    const helper = new QubicHelper();
    const sourceId = helper.createIdPackage(TREASURY_SEED);

    const packageBuilder = new QubicPackageBuilder(sourceId.publicId);
    packageBuilder.setAmount(Number(withdrawal.amount));
    packageBuilder.setDestinationPublicId(withdrawal.to_address);
    packageBuilder.setTick(targetTick);

    const qubicPackage = packageBuilder.build();
    const transaction = new QubicTransaction(qubicPackage);
    await transaction.build(TREASURY_SEED);

    const packageData = transaction.getPackageData();
    const base64Transaction = packageData.toString('base64');

    console.log('📡 Broadcasting transaction to Qubic network...');
    const broadcastResponse = await fetch(`${QUBIC_RPC_URL}broadcast-transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encodedTransaction: base64Transaction })
    });

    if (!broadcastResponse.ok) {
      const errorText = await broadcastResponse.text();
      console.error('❌ Broadcast failed:', errorText);
      throw new Error(`Broadcast failed: ${errorText}`);
    }

    const broadcastResult = await broadcastResponse.json();
    const txHash = broadcastResult.txId || transaction.getTxId();

    if (!txHash) {
      throw new Error('No transaction ID returned from broadcast');
    }

    console.log('✅ Transaction broadcast successful:', txHash);

    // Update database
    console.log('💾 Updating database...');
    await Bolt Database
      .from('withdrawals')
      .update({
        status: 'completed',
        tx_hash: txHash,
        completed_at: new Date().toISOString(),
      })
      .eq('id', withdrawalId);

    await Bolt Database
      .from('transactions')
      .update({
        status: 'completed',
        tx_hash: txHash,
      })
      .eq('user_id', withdrawal.user_id)
      .eq('type', 'withdrawal')
      .is('tx_hash', null)
      .order('created_at', { ascending: false })
      .limit(1);

    const processingTime = Date.now() - startTime;
    console.log(`✅ Withdrawal completed in ${processingTime}ms`);

    res.json({
      success: true,
      txHash,
      explorerUrl: `https://explorer.qubic.org/network/tx/${txHash}`,
      message: 'Withdrawal broadcast successfully to Qubic blockchain!',
      processingTime
    });

  } catch (error) {
    console.error('❌ Withdrawal processing error:', error);

    try {
      if (req.body.withdrawalId) {
        await Bolt Database
          .from('withdrawals')
          .update({ status: 'failed' })
          .eq('id', req.body.withdrawalId);
      }
    } catch (dbError) {
      console.error('Failed to update withdrawal status:', dbError);
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Unknown error occurred'
    });
  }
});

// Get treasury info endpoint
app.get('/treasury-info', async (req, res) => {
  try {
    const helper = new QubicHelper();
    const treasuryId = helper.createIdPackage(TREASURY_SEED);

    res.json({
      success: true,
      treasuryAddress: treasuryId.publicId,
      message: 'Treasury wallet configured'
    });
  } catch (error) {
    console.error('Treasury info error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get treasury info'
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log('🚀 Qubic Withdrawal Service Started');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`💰 Treasury configured: ${TREASURY_SEED ? 'Yes ✅' : 'No ❌'}`);
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, shutting down gracefully...');
  process.exit(0);
});
