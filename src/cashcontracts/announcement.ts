import { Contract } from 'cashscript';
import { compileFile } from 'cashc';
import { URL } from 'url';
import ElectrumService from '../apis/ElectrumServer/ElectrumServer';

const artifact = compileFile(new URL('announcement.cash', import.meta.url));

const addressType = 'p2sh20';
const provider = ElectrumService()

// Instantiate a new contract using the compiled artifact and network provider
// AND providing the constructor parameters (none)
const contract = new Contract(artifact, [], { provider, addressType });

console.log('contract address:', contract.address);