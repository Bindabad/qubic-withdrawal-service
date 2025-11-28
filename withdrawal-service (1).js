/**
 * Qubic Withdrawal Service - Node.js Backend
 */

const express = require('express');
const cors = require('cors');
const { QubicHelper, QubicTransaction, QubicPackageBuilder } = require('@qubic-lib/qubic-ts-library');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const TREASURY_SEED = process.env.TREASURY_WALLET_SEED;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUBIC_RPC_URL = 'https://rpc.qubic.org/v1/';

if (!TREASURY_SEED || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing required environment variables!');
  process.exit(1);
}

app.use(express.json());
app.use(cors({ origin: '*' }));

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Qubic Withdrawal Service',
    timestamp: new Date().toISOString()
  });
});

app.post('/process-withdrawal', async (req, res) => {
  const startTime = Date.now();
  console.log('📥 Received withdrawal request:', req.body);

  try {
    const { withdrawalId } = req.body;
    if (!withdrawalId) {
      return res.status(400).json({ success: false, error: 'Missing withdrawalId' });
    }

    const { data: withdrawal, error: fetchError } = await supabase
      .from('withdrawals')
      .select('*')
      .eq('id', withdrawalId)
      .single();

    if (fetchError || !withdrawal) {
      return res.status(404).json({ success: false, error: 'Withdrawal not found' });
    }

    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ success: false, error: `Already ${withdrawal.status}` });
    }

    const { data: aiMined } = await supabase
      .from('transactions')
      .select('amount')
      .eq('type', 'ai_mining');

    const totalAiMined = aiMined?.reduce((sum, t) => sum + (t.amount || 0), 0) || 0;
    const treasuryBalance = totalAiMined * 0.55;

    const { data: totalWithdrawn } = await supabase
      .from('withdrawals')
      .select('amount')
      .eq('status', 'completed');

    const totalWithdrawalAmount = totalWithdrawn?.reduce((sum, w) => sum + (w.amount || 0), 0) || 0;
    const availableBalance = treasuryBalance - totalWithdrawalAmount;

    if (availableBalance < Number(withdrawal.amount)) {
      await supabase.from('withdrawals').update({ status: 'failed' }).eq('id', withdrawalId);
      return res.status(400).json({
        success: false,
        error: `Insufficient balance. Available: ${availableBalance.toLocaleString()} QUBIC`
      });
    }

    const tickResponse = await fetch(`${QUBIC_RPC_URL}status`);
    const tickData = await tickResponse.json();
    const currentTick = tickData.lastProcessedTick?.tickNumber || 0;
    const targetTick = currentTick + 20;

    const helper = new QubicHelper();
    const sourcePublicId = await helper.createPublicIdFromSeed(TREASURY_SEED);

    const packageBuilder = new QubicPackageBuilder(sourcePublicId.publicId);
    packageBuilder.setAmount(Number(withdrawal.amount));
    packageBuilder.setDestinationPublicId(withdrawal.to_address);
    packageBuilder.setTick(targetTick);

    const qubicPackage = packageBuilder.build();
    const transaction = new QubicTransaction(qubicPackage);
    await transaction.build(TREASURY_SEED);

    const packageData = transaction.getPackageData();
    const base64Transaction = packageData.toString('base64');

    const broadcastResponse = await fetch(`${QUBIC_RPC_URL}broadcast-transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encodedTransaction: base64Transaction })
    });

    if (!broadcastResponse.ok) {
      throw new Error('Broadcast failed');
    }

    const broadcastResult = await broadcastResponse.json();
    const txHash = broadcastResult.txId || transaction.getTxId();

    await supabase.from('withdrawals').update({
      status: 'completed',
      tx_hash: txHash,
      completed_at: new Date().toISOString(),
    }).eq('id', withdrawalId);

    await supabase.from('transactions').update({
      status: 'completed',
      tx_hash: txHash,
    }).eq('user_id', withdrawal.user_id)
      .eq('type', 'withdrawal')
      .is('tx_hash', null)
      .order('created_at', { ascending: false })
      .limit(1);

    const processingTime = Date.now() - startTime;
    console.log(`✅ Completed in ${processingTime}ms`);

    res.json({
      success: true,
      txHash,
      explorerUrl: `https://explorer.qubic.org/network/tx/${txHash}`,
      message: 'Withdrawal broadcast successfully!',
      processingTime
    });

  } catch (error) {
    console.error('❌ Error:', error);
    if (req.body.withdrawalId) {
      await supabase.from('withdrawals').update({ status: 'failed' }).eq('id', req.body.withdrawalId);
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/treasury-info', async (req, res) => {
  try {
    const helper = new QubicHelper();
    const treasuryPublicId = await helper.createPublicIdFromSeed(TREASURY_SEED);
    res.json({
      success: true,
      treasuryAddress: treasuryPublicId.publicId,
      message: 'Treasury wallet configured'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get treasury info' });
  }
});

app.listen(PORT, () => {
  console.log('🚀 Qubic Withdrawal Service Started');
  console.log(`📡 Port: ${PORT}`);
  console.log(`💰 Treasury: ${TREASURY_SEED ? '✅' : '❌'}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));