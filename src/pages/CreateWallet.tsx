import React from 'react'
import NavBar from '../components/NavBar'
import WalletCreation from '../components/WalletCreation'
const CreateWallet = () => {
  return (
    <>
    <section className = 'flex flex-col min-h-screen bg-black items-center'>
        <WalletCreation/>
    </section>
    </>
  )
}

export default CreateWallet