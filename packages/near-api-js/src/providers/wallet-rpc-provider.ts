/**
 * @module
 * @description
 * This module contains the {@link JsonRpcProvider} client class
 * which can be used to interact with the [NEAR RPC API](https://docs.near.org/api/rpc/introduction).
 * @see {@link providers/provider | providers} for a list of request and response types
 */
import {
    AccessKeyWithPublicKey,
    Provider,
    FinalExecutionOutcome,
    NodeStatusResult,
    BlockId,
    BlockReference,
    BlockResult,
    BlockChangeResult,
    ChangeResult,
    ChunkId,
    ChunkResult,
    EpochValidatorInfo,
    NearProtocolConfig,
    LightClientProof,
    LightClientProofRequest,
    GasPrice,
    QueryResponseKind
} from './provider';
import { TypedError, ErrorContext } from '../utils/errors';
import { baseEncode } from 'borsh';
import exponentialBackoff from '../utils/exponential-backoff';
import { parseRpcError } from '../utils/rpc_errors';
import { SignedTransaction, Transaction } from '../transaction';

/** @hidden */
export { TypedError, ErrorContext };

// Default number of retries before giving up on a request.
const REQUEST_RETRY_NUMBER = 12;

// Default wait until next retry in millis.
const REQUEST_RETRY_WAIT = 500;

// Exponential back off for waiting to retry.
const REQUEST_RETRY_WAIT_BACKOFF = 1.5;

/// Keep ids unique across all connections.
let _nextId = 123;

export interface RequestParams {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params: object;
}

export interface WalletProvider {
    getAccount: () => Promise<string>;
    request: (args: RequestParams) => Promise<any>;
    on: (message: string, listener: (...args: any[]) => void ) => void;
}

/**
 * Client class to interact with the [NEAR RPC API](https://docs.near.org/api/rpc/introduction).
 * @see [https://github.com/near/nearcore/tree/master/chain/jsonrpc](https://github.com/near/nearcore/tree/master/chain/jsonrpc)
 */
export class WalletRpcProvider extends Provider {
    /** @hidden */
    private _provider: WalletProvider | null = null;

    private _network = '';
    private _account = '';
    private _pubKeys: string[] = [];

    /**
     * get chain id (near or testnet)
     */
    get network(): string {
        return this._network;
    }

    /**
     * get selected account id
     */
    get account(): string {
        return this._account;
    }


    /**
     * get access key of selected account id
     */
    get pubKeys(): string[] {
        return this._pubKeys;
    }

    /**
     * get type of provider
     */
    get isWalletProvider(): boolean {
        return true;
    }

    /**
     * @param provider WalletProvider
     */
    constructor(provider: WalletProvider) {
        super();
        this._provider = provider;
        this._provider.on('chainChanged', this.updateNetwork.bind(this));
        this._provider.on('accountsChanged', this.updateAccount.bind(this));
        this.init();
    }

    private async init() {
        if(this._provider) {
            const { chain_id } = await this.status();
            this._network = chain_id;
            this._account = await this._provider.getAccount();
        }
    }

    /**
     * update selected chain id
     */
    private updateNetwork(chainId: string) {
        this._network = chainId;
    }

    /**
     * update selected account
     */
    private updateAccount(account: { address: string; pubKeys: string[]}) {
        this._account = account.address;
        this._pubKeys = account.pubKeys;
    }

    /**
     * Add a new listener (eg: chainChanged, accountsChanged)
     */
    on(message: string, listener: (...args: any[]) => void ): void {
        if(this._provider) {
            this._provider.on(message, listener);
        }
    }

    /**
     * Gets the RPC's status
     * @see [https://docs.near.org/docs/develop/front-end/rpc#general-validator-status](https://docs.near.org/docs/develop/front-end/rpc#general-validator-status)
     */
    async status(): Promise<NodeStatusResult> {
        return this.sendJsonRpc('status', []);
    }

    /**
     * Sends a signed transaction to the RPC and waits until transaction is fully complete
     * @see [https://docs.near.org/docs/develop/front-end/rpc#send-transaction-await](https://docs.near.org/docs/develop/front-end/rpc#general-validator-status)
     *
     * @param signedTransaction The signed transaction being sent
     */
    async sendTransaction(signedTransaction: SignedTransaction): Promise<FinalExecutionOutcome> {
        const bytes = signedTransaction.encode();
        return this.sendJsonRpc('broadcast_tx_commit', [Buffer.from(bytes).toString('base64')]);
    }

    /**
     * Sends a signed transaction to the RPC and immediately returns transaction hash
     * See [docs for more info](https://docs.near.org/docs/develop/front-end/rpc#send-transaction-async)
     * @param signedTransaction The signed transaction being sent
     * @returns {Promise<FinalExecutionOutcome>}
     */
    async sendTransactionAsync(signedTransaction: SignedTransaction): Promise<FinalExecutionOutcome> {
        const bytes = signedTransaction.encode();
        return this.sendJsonRpc('broadcast_tx_async', [Buffer.from(bytes).toString('base64')]);
    }

    /**
     * Sign and Sends a transaction to the RPC and waits until transaction is fully complete
     * @see {@link https://docs.near.org/docs/develop/front-end/rpc#send-transaction-await}
     *
     * @param transaction The transaction being sent
     */
    async signAndSendTransaction(transaction: Transaction): Promise<FinalExecutionOutcome> {
        const bytes = transaction.encode();
        return this.sendJsonRpc('signAndSendTransaction', [Buffer.from(bytes).toString('base64')]);
    }

    /**
     * Gets a transaction's status from the RPC
     * @see [https://docs.near.org/docs/develop/front-end/rpc#transaction-status](https://docs.near.org/docs/develop/front-end/rpc#general-validator-status)
     *
     * @param txHash A transaction hash as either a Uint8Array or a base58 encoded string
     * @param accountId The NEAR account that signed the transaction
     */
    async txStatus(txHash: Uint8Array | string, accountId: string): Promise<FinalExecutionOutcome> {
        if (typeof txHash === 'string') {
            return this.txStatusString(txHash, accountId);
        } else {
            return this.txStatusUint8Array(txHash, accountId);
        }
    }

    private async txStatusUint8Array(txHash: Uint8Array, accountId: string): Promise<FinalExecutionOutcome> {
        return this.sendJsonRpc('tx', [baseEncode(txHash), accountId]);
    }

    private async txStatusString(txHash: string, accountId: string): Promise<FinalExecutionOutcome> {
        return this.sendJsonRpc('tx', [txHash, accountId]);
    }

    /**
     * Gets a transaction's status from the RPC with receipts
     * See [docs for more info](https://docs.near.org/docs/develop/front-end/rpc#transaction-status-with-receipts)
     * @param txHash The hash of the transaction
     * @param accountId The NEAR account that signed the transaction
     * @returns {Promise<FinalExecutionOutcome>}
     */
    async txStatusReceipts(txHash: Uint8Array | string, accountId: string): Promise<FinalExecutionOutcome> {
        if (typeof txHash === 'string') {
            return this.sendJsonRpc('EXPERIMENTAL_tx_status', [txHash, accountId]);
        }
        else {
            return this.sendJsonRpc('EXPERIMENTAL_tx_status', [baseEncode(txHash), accountId]);
        }
    }

    /**
     * Query the RPC by passing an {@link providers/provider!RpcQueryRequest}
     * @see [https://docs.near.org/api/rpc/contracts](https://docs.near.org/api/rpc/contracts)
     *
     * @typeParam T the shape of the returned query response
     */
    async query<T extends QueryResponseKind>(...args: any[]): Promise<T> {
        let result;
        if (args.length === 1) {
            const { block_id, blockId, ...otherParams } = args[0];
            result = await this.sendJsonRpc<T>('query', { ...otherParams, block_id: block_id || blockId });
        } else {
            const [path, data] = args;
            result = await this.sendJsonRpc<T>('query', [path, data]);
        }
        if (result && result.error) {
            throw new TypedError(`Querying failed: ${result.error}.\n${JSON.stringify(result, null, 2)}`, result.error.name);
        }
        return result;
    }

    /**
     * Query for block info from the RPC
     * pass block_id OR finality as blockQuery, not both
     * @see [https://docs.near.org/api/rpc/block-chunk](https://docs.near.org/api/rpc/block-chunk)
     *
     * @param blockQuery {@link providers/provider!BlockReference} (passing a {@link providers/provider!BlockId} is deprecated)
     */
    async block(blockQuery: BlockId | BlockReference): Promise<BlockResult> {
        const { finality } = blockQuery as any;
        const { blockId } = blockQuery as any;
        return this.sendJsonRpc('block', { block_id: blockId, finality });
    }

    /**
     * Query changes in block from the RPC
     * pass block_id OR finality as blockQuery, not both
     * @see [https://docs.near.org/api/rpc/block-chunk](https://docs.near.org/api/rpc/block-chunk)
     */
    async blockChanges(blockQuery: BlockReference): Promise<BlockChangeResult> {
        const { finality } = blockQuery as any;
        const { blockId } = blockQuery as any;
        return this.sendJsonRpc('EXPERIMENTAL_changes_in_block', { block_id: blockId, finality });
    }

    /**
     * Queries for details about a specific chunk appending details of receipts and transactions to the same chunk data provided by a block
     * @see [https://docs.near.org/api/rpc/block-chunk](https://docs.near.org/api/rpc/block-chunk)
     *
     * @param chunkId Hash of a chunk ID or shard ID
     */
    async chunk(chunkId: ChunkId): Promise<ChunkResult> {
        return this.sendJsonRpc('chunk', [chunkId]);
    }

    /**
     * Query validators of the epoch defined by the given block id.
     * @see [https://docs.near.org/api/rpc/network#validation-status](https://docs.near.org/api/rpc/network#validation-status)
     *
     * @param blockId Block hash or height, or null for latest.
     */
    async validators(blockId: BlockId | null): Promise<EpochValidatorInfo> {
        return this.sendJsonRpc('validators', [blockId]);
    }

    /**
     * Gets the protocol config at a block from RPC
     *
     * @param blockReference specifies the block to get the protocol config for
     */
    async experimental_protocolConfig(blockReference: BlockReference | { sync_checkpoint: 'genesis' }): Promise<NearProtocolConfig> {
        const { blockId, ...otherParams } = blockReference as any;
        return await this.sendJsonRpc('EXPERIMENTAL_protocol_config', {...otherParams, block_id: blockId});
    }

    /**
     * Gets a light client execution proof for verifying execution outcomes
     * @see [https://github.com/nearprotocol/NEPs/blob/master/specs/ChainSpec/LightClient.md#light-client-proof](https://github.com/nearprotocol/NEPs/blob/master/specs/ChainSpec/LightClient.md#light-client-proof)
     */
    async lightClientProof(request: LightClientProofRequest): Promise<LightClientProof> {
        return await this.sendJsonRpc('EXPERIMENTAL_light_client_proof', request);
    }

    /**
     * Gets access key changes for a given array of accountIds
     * See [docs for more info](https://docs.near.org/docs/develop/front-end/rpc#view-access-key-changes-all)
     * @returns {Promise<ChangeResult>}
     */
    async accessKeyChanges(accountIdArray: string[], blockQuery: BlockReference): Promise<ChangeResult> {
        const { finality } = blockQuery as any;
        const { blockId } = blockQuery as any;
        return this.sendJsonRpc('EXPERIMENTAL_changes', {
            changes_type: 'all_access_key_changes',
            account_ids: accountIdArray,
            block_id: blockId,
            finality
        });
    }

    /**
     * Gets single access key changes for a given array of access keys
     * pass block_id OR finality as blockQuery, not both
     * See [docs for more info](https://docs.near.org/docs/develop/front-end/rpc#view-access-key-changes-single)
     * @returns {Promise<ChangeResult>}
     */
    async singleAccessKeyChanges(accessKeyArray: AccessKeyWithPublicKey[], blockQuery: BlockReference): Promise<ChangeResult> {
        const { finality } = blockQuery as any;
        const { blockId } = blockQuery as any;
        return this.sendJsonRpc('EXPERIMENTAL_changes', {
            changes_type: 'single_access_key_changes',
            keys: accessKeyArray,
            block_id: blockId,
            finality
        });
    }

    /**
     * Gets account changes for a given array of accountIds
     * pass block_id OR finality as blockQuery, not both
     * See [docs for more info](https://docs.near.org/docs/develop/front-end/rpc#view-account-changes)
     * @returns {Promise<ChangeResult>}
     */
    async accountChanges(accountIdArray: string[], blockQuery: BlockReference): Promise<ChangeResult> {
        const { finality } = blockQuery as any;
        const { blockId } = blockQuery as any;
        return this.sendJsonRpc('EXPERIMENTAL_changes', {
            changes_type: 'account_changes',
            account_ids: accountIdArray,
            block_id: blockId,
            finality
        });
    }

    /**
     * Gets contract state changes for a given array of accountIds
     * pass block_id OR finality as blockQuery, not both
     * Note: If you pass a keyPrefix it must be base64 encoded
     * See [docs for more info](https://docs.near.org/docs/develop/front-end/rpc#view-contract-state-changes)
     * @returns {Promise<ChangeResult>}
     */
    async contractStateChanges(accountIdArray: string[], blockQuery: BlockReference, keyPrefix = ''): Promise<ChangeResult> {
        const { finality } = blockQuery as any;
        const { blockId } = blockQuery as any;
        return this.sendJsonRpc('EXPERIMENTAL_changes', {
            changes_type: 'data_changes',
            account_ids: accountIdArray,
            key_prefix_base64: keyPrefix,
            block_id: blockId,
            finality
        });
    }

    /**
     * Gets contract code changes for a given array of accountIds
     * pass block_id OR finality as blockQuery, not both
     * Note: Change is returned in a base64 encoded WASM file
     * See [docs for more info](https://docs.near.org/docs/develop/front-end/rpc#view-contract-code-changes)
     * @returns {Promise<ChangeResult>}
     */
    async contractCodeChanges(accountIdArray: string[], blockQuery: BlockReference): Promise<ChangeResult> {
        const { finality } = blockQuery as any;
        const { blockId } = blockQuery as any;
        return this.sendJsonRpc('EXPERIMENTAL_changes', {
            changes_type: 'contract_code_changes',
            account_ids: accountIdArray,
            block_id: blockId,
            finality
        });
    }

    /**
     * Returns gas price for a specific block_height or block_hash.
     * @see [https://docs.near.org/api/rpc/gas](https://docs.near.org/api/rpc/gas)
     *
     * @param blockId Block hash or height, or null for latest.
     */
    async gasPrice(blockId: BlockId | null): Promise<GasPrice> {
        return await this.sendJsonRpc('gas_price', [blockId]);
    }

    /**
     * Directly call the RPC specifying the method and params
     *
     * @param method RPC method
     * @param params Parameters to the method
     */
    async sendJsonRpc<T>(method: string, params: object): Promise<T> {
        const response = await exponentialBackoff(REQUEST_RETRY_WAIT, REQUEST_RETRY_NUMBER, REQUEST_RETRY_WAIT_BACKOFF, async () => {
            try {
                if (this._provider) {
                    const request: RequestParams = {
                        method,
                        params,
                        id: (_nextId++),
                        jsonrpc: '2.0'
                    };
                    const response = await this._provider.request(request);
                    if (Array.isArray(response)) {
                        // Success when error is not exist
                        const txStatus = await this.txStatusString(response[0], this._account);
                        return { reesult: txStatus };
                    } else if ((response as any).error) {
                        const error = (response as any).error;
                        if (typeof error.data === 'object') {
                            if (typeof error.data.error_message === 'string' && typeof error.data.error_type === 'string') {
                                // if error data has error_message and error_type properties, we consider that node returned an error in the old format
                                throw new TypedError(error.data.error_message, error.data.error_type);
                            }
    
                            throw parseRpcError(error.data);
                        } else {
                            const errorMessage = `[${error.code}] ${error.message}: ${error.data}`;
                            // NOTE: All this hackery is happening because structured errors not implemented
                            // TODO: Fix when https://github.com/nearprotocol/nearcore/issues/1839 gets resolved
                            if (error.data === 'Timeout' || errorMessage.includes('Timeout error')
                                || errorMessage.includes('query has timed out')) {
                                throw new TypedError(errorMessage, 'TimeoutError');
                            }
    
                            throw new TypedError(errorMessage, error.name);
                        }
                    }
                    // Success when response.error is not exist
                    return { result: response };
                }
                throw new Error('Provider not exist');
            } catch (error) {
                if (error.type === 'TimeoutError') {
                    if (!process.env['NEAR_NO_LOGS']) {
                        console.warn(`Retrying request to ${method} as it has timed out`, params);
                    }
                    return null;
                }

                throw error;
            }
        });
        const { result } = response;
        // From jsonrpc spec:
        // result
        //   This member is REQUIRED on success.
        //   This member MUST NOT exist if there was an error invoking the method.
        if (typeof result === 'undefined') {
            throw new TypedError(
                `Exceeded ${REQUEST_RETRY_NUMBER} attempts for request to ${method}.`, 'RetriesExceeded');
        }
        return result;
    }
}
