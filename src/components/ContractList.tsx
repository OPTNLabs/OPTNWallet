// import React from 'react';

// interface ContractListProps {
//   contracts: any[];
//   onSelectContract: (contract: any) => void;
// }

// const ContractList: React.FC<ContractListProps> = ({
//   contracts,
//   onSelectContract,
// }) => {
//   return (
//     <div className="mb-6">
//       <h3 className="text-lg font-semibold mb-2">Instantiated Contracts</h3>
//       {contracts.length === 0 ? (
//         <p>No contracts instantiated.</p>
//       ) : (
//         <ul className="space-y-4">
//           {contracts.map((contract, index) => (
//             <li key={index} className="p-4 border rounded-lg">
//               <h4 className="text-lg font-semibold">
//                 {contract.contract_name}
//               </h4>
//               <p>Address: {contract.address}</p>
//               <p>Balance: {contract.balance.toString()}</p>
//               <button
//                 className="bg-blue-500 text-white py-2 px-4 rounded mt-2"
//                 onClick={() => onSelectContract(contract)}
//               >
//                 Interact with Contract
//               </button>
//             </li>
//           ))}
//         </ul>
//       )}
//     </div>
//   );
// };

// export default ContractList;
