// our interface
export interface ContractInfo {
    contract?: {
        abiFunction: AbiFunction;
        redeemScript: Uint8Array;
        artifact: Partial<Artifact>;
    }
}

// imported from cashcript version 0.8.0 and above
// import { AbiFunction, AbiInput, Artifact } from "cashscript";
export interface AbiInput {
    name: string;
    type: string;
}
export interface AbiFunction {
    name: string;
    covenant?: boolean;
    inputs: AbiInput[];
}

export interface Artifact {
    contractName: string;
    constructorInputs: AbiInput[];
    abi: AbiFunction[];
    bytecode: string;
    source: string;
    compiler: {
        name: string;
        version: string;
    };
    updatedAt: string;
}