import { Address, GweiBalance, TokenSymbol, Transaction, Tx } from "@/plugins/types";
import { walletData } from "@/plugins/walletData";
import { accessorType } from "@/store";
import { Withdraw } from "zksync/build/types";

/**
 * Transaction processing action
 *
 * @param {Address} address
 * @param {TokenSymbol} token
 * @param {TokenSymbol} feeToken
 * @param {GweiBalance} amountBigValue
 * @param {GweiBalance} feeBigValue
 * @param store
 * @returns {Promise<Transaction | Transaction[]>}
 */
export const transaction = async (
  address: Address,
  token: TokenSymbol,
  feeToken: TokenSymbol,
  amountBigValue: GweiBalance,
  feeBigValue: GweiBalance,
  store: typeof accessorType,
): Promise<Transaction | Transaction[]> => {
  const syncWallet = walletData.get().syncWallet;
  let nonce = await syncWallet!.getNonce("committed");
  const transferTx = {
    fee: 0,
    nonce,
    amount: amountBigValue,
    to: address,
    token,
  };
  nonce += 1;
  const feeTx = {
    fee: feeBigValue,
    nonce,
    amount: 0,
    to: syncWallet!.address(),
    token: feeToken,
  };

  /**
   * @todo: process case when there are 2 transactions
   */
  if (token === feeToken) {
    const transaction = (await syncWallet!.syncTransfer({
      to: address,
      token,
      amount: amountBigValue,
      fee: feeBigValue,
    })) as Transaction;
    await store.transaction.watchTransaction({ transactionHash: transaction.txHash, tokenSymbol: token, type: "withdraw" });
    return transaction;
  }
  const transferTransaction: Transaction[] = await syncWallet!.syncMultiTransfer([transferTx, feeTx]);
  for (let a = 0; a < transferTransaction.length; a++) {
    await store.transaction.watchTransaction({ transactionHash: transferTransaction[a].txHash, tokenSymbol: a === 0 ? token : feeToken, type: "withdraw" });
  }
  return transferTransaction;
};

interface WithdrawParams {
  address: Address;
  token: TokenSymbol;
  feeToken: TokenSymbol;
  amount: GweiBalance;
  fastWithdraw: boolean;
  fees: GweiBalance;
  store: any;
}

/**
 * Generic method for batch transaction creation
 *
 * @param address
 * @param token
 * @param feeToken
 * @param amount
 * @param fastWithdraw
 * @param fees
 * @param store
 * @return {Promise<{txData: *, txHash: *}[]>}
 */
export const withdraw = async ({ address, token, feeToken, amount, fastWithdraw, fees, store }: WithdrawParams): Promise<any> => {
  const syncWallet = walletData.get().syncWallet;
  const amountBigValue = amount;
  const feeBigValue = fees;
  if (token === feeToken) {
    const transaction = await syncWallet!.withdrawFromSyncToEthereum({
      ethAddress: address,
      token,
      amount: amountBigValue,
      fee: feeBigValue,
      fastProcessing: fastWithdraw,
    });
    await store.transaction.watchTransaction({ transactionHash: transaction.txHash, tokenSymbol: token, type: "transfer" });
    return transaction;
  } else {
    const withdrawals = [
      {
        ethAddress: address,
        amount: amountBigValue,
        fee: "0",
        token,
      },
    ];
    const transfers = [
      {
        to: syncWallet!.address(),
        token: feeToken,
        amount: "0",
        fee: feeBigValue,
      },
    ];
    if (!syncWallet!.signer) {
      throw new Error("zkSync signer is required for sending zksync transactions.");
    } else if (transfers.length === 0) {
      throw new Error("No transfers in queue");
    }

    const signedTransactions = [] as Array<{
      tx: Withdraw;
      signature: any;
    }>;
    let signWithdrawTransaction = null;

    let nextNonce = await syncWallet!.getNonce();

    for (const item of withdrawals) {
      const nonce = nextNonce;
      nextNonce += 1;

      signWithdrawTransaction = await syncWallet!
        .signWithdrawFromSyncToEthereum({
          ...item,
          nonce,
        })
        .catch((error) => {
          throw new Error("Error while performing signWithdrawFromSyncToEthereum: " + error.message);
        });

      signedTransactions.push({ tx: signWithdrawTransaction.tx as Withdraw, signature: signWithdrawTransaction.ethereumSignature });
    }

    for (const item of transfers) {
      const nonce = nextNonce;
      nextNonce += 1;

      const signTransaction = await syncWallet!
        .signSyncTransfer({
          ...item,
          nonce,
        })
        .catch((error) => {
          throw new Error("Error while performing signSyncTransfer: " + error.message);
        });

      signedTransactions.push({ tx: signTransaction.tx as Withdraw, signature: signTransaction.ethereumSignature });
    }

    const transactionHashes = await syncWallet!.provider.submitTxsBatch(signedTransactions).catch((error) => {
      throw new Error("Error while performing submitTxsBatch: " + error.message);
    });
    for (let a = 0; a < transactionHashes.length; a++) {
      await store.transaction.watchTransaction({ transactionHash: transactionHashes[a], tokenSymbol: a === 0 ? token : feeToken, type: "transfer" });
    }
    return transactionHashes.map((txHash, index) => ({
      txData: signedTransactions[index],
      txHash,
    }));
  }
};

/**
 * Deposit action method
 *
 * @param {TokenSymbol} token
 * @param {GweiBalance} amount
 * @param store
 * @returns {Promise<any>}
 */
export const deposit = async (token: TokenSymbol, amount: GweiBalance, store: any) => {
  const wallet = walletData.get().syncWallet;
  const depositResponse = await wallet?.depositToSyncFromEthereum({
    depositTo: wallet.address(),
    token,
    amount,
  });
  await store.transaction.watchDeposit({ depositTx: depositResponse, tokenSymbol: token, amount });
  return depositResponse;
};
