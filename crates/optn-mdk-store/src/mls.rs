//! OpenMLS's storage provider: group state, proposals, leaf nodes and keys.
//!
//! Keys and values are OpenMLS's own types written with MDK's `MlsCodec`, as
//! both of MDK's stores write them. A group's leaf nodes, queued proposals
//! and epoch key pairs are each one record, a list, so that a snapshot or a
//! deletion of the group finds them without listing the database.

use mdk_storage_traits::mls_codec::{GroupDataType, STORAGE_PROVIDER_VERSION};
use mdk_storage_traits::MdkStorageError;
use openmls_traits::storage::{traits, StorageProvider};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::keys::{self, decode, encode};
use crate::record::Family;
use crate::{MdkStore, Outcome, Session};

/// A group's leaf nodes, in the order they were appended.
type LeafNodes = Vec<Vec<u8>>;
/// A group's queued proposals, in the order they were queued: reference, proposal.
type Proposals = Vec<(Vec<u8>, Vec<u8>)>;
/// A group's HPKE key pairs: epoch, leaf index, key pairs.
type EpochKeyPairs = Vec<(Vec<u8>, u32, Vec<u8>)>;

fn read_list<T: DeserializeOwned + Default>(
    session: &mut Session<'_>,
    family: Family,
    key: &[u8],
) -> Outcome<T, MdkStorageError> {
    Ok(match session.get(family, key)? {
        Some(payload) => decode(&payload)?,
        None => T::default(),
    })
}

/// Write a list, or delete its record once it is empty.
fn write_list<T: Serialize>(
    session: &mut Session<'_>,
    family: Family,
    key: &[u8],
    list: &[T],
) -> Outcome<(), MdkStorageError> {
    if list.is_empty() {
        session.delete(family, key)?;
    } else {
        session.put(family, key, &zeroize::Zeroizing::new(encode(list)?))?;
    }
    Ok(())
}

impl MdkStore {
    fn write_group_data<G: Serialize, V: Serialize>(
        &self,
        group: &G,
        kind: GroupDataType,
        value: &V,
    ) -> Result<(), MdkStorageError> {
        self.run(|session| {
            let key = keys::group_data(&encode(group)?, kind);
            session.put(
                Family::MlsGroupData,
                &key,
                &zeroize::Zeroizing::new(encode(value)?),
            )?;
            Ok(())
        })
    }

    fn read_group_data<G: Serialize, V: DeserializeOwned>(
        &self,
        group: &G,
        kind: GroupDataType,
    ) -> Result<Option<V>, MdkStorageError> {
        self.run(|session| {
            let key = keys::group_data(&encode(group)?, kind);
            Ok(match session.get(Family::MlsGroupData, &key)? {
                Some(payload) => Some(decode(&payload)?),
                None => None,
            })
        })
    }

    fn delete_group_data<G: Serialize>(
        &self,
        group: &G,
        kind: GroupDataType,
    ) -> Result<(), MdkStorageError> {
        self.run(|session| {
            session.delete(
                Family::MlsGroupData,
                &keys::group_data(&encode(group)?, kind),
            )?;
            Ok(())
        })
    }

    fn write_keyed<K: Serialize, V: Serialize>(
        &self,
        family: Family,
        key: &K,
        value: &V,
    ) -> Result<(), MdkStorageError> {
        self.run(|session| {
            session.put(
                family,
                &encode(key)?,
                &zeroize::Zeroizing::new(encode(value)?),
            )?;
            Ok(())
        })
    }

    fn read_keyed<K: Serialize, V: DeserializeOwned>(
        &self,
        family: Family,
        key: &K,
    ) -> Result<Option<V>, MdkStorageError> {
        self.run(|session| {
            Ok(match session.get(family, &encode(key)?)? {
                Some(payload) => Some(decode(&payload)?),
                None => None,
            })
        })
    }

    fn delete_keyed<K: Serialize>(&self, family: Family, key: &K) -> Result<(), MdkStorageError> {
        self.run(|session| {
            session.delete(family, &encode(key)?)?;
            Ok(())
        })
    }
}

macro_rules! group_data {
    ($write:ident, $read:ident, $delete:ident, $value:ident, $kind:ident) => {
        fn $write<
            GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
            $value: traits::$value<STORAGE_PROVIDER_VERSION>,
        >(
            &self,
            group_id: &GroupId,
            value: &$value,
        ) -> Result<(), Self::Error> {
            self.write_group_data(group_id, GroupDataType::$kind, value)
        }

        fn $read<
            GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
            $value: traits::$value<STORAGE_PROVIDER_VERSION>,
        >(
            &self,
            group_id: &GroupId,
        ) -> Result<Option<$value>, Self::Error> {
            self.read_group_data(group_id, GroupDataType::$kind)
        }

        fn $delete<GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>>(
            &self,
            group_id: &GroupId,
        ) -> Result<(), Self::Error> {
            self.delete_group_data(group_id, GroupDataType::$kind)
        }
    };
}

impl StorageProvider<STORAGE_PROVIDER_VERSION> for MdkStore {
    type Error = MdkStorageError;

    group_data!(
        write_mls_join_config,
        mls_group_join_config,
        delete_group_config,
        MlsGroupJoinConfig,
        JoinGroupConfig
    );
    group_data!(write_tree, tree, delete_tree, TreeSync, Tree);
    group_data!(
        write_interim_transcript_hash,
        interim_transcript_hash,
        delete_interim_transcript_hash,
        InterimTranscriptHash,
        InterimTranscriptHash
    );
    group_data!(
        write_context,
        group_context,
        delete_context,
        GroupContext,
        Context
    );
    group_data!(
        write_confirmation_tag,
        confirmation_tag,
        delete_confirmation_tag,
        ConfirmationTag,
        ConfirmationTag
    );
    group_data!(
        write_message_secrets,
        message_secrets,
        delete_message_secrets,
        MessageSecrets,
        MessageSecrets
    );
    group_data!(
        write_resumption_psk_store,
        resumption_psk_store,
        delete_all_resumption_psk_secrets,
        ResumptionPskStore,
        ResumptionPskStore
    );
    group_data!(
        write_own_leaf_index,
        own_leaf_index,
        delete_own_leaf_index,
        LeafNodeIndex,
        OwnLeafIndex
    );
    group_data!(
        write_group_epoch_secrets,
        group_epoch_secrets,
        delete_group_epoch_secrets,
        GroupEpochSecrets,
        GroupEpochSecrets
    );

    // OpenMLS orders these two generics the other way round.
    fn write_group_state<
        GroupState: traits::GroupState<STORAGE_PROVIDER_VERSION>,
        GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        group_state: &GroupState,
    ) -> Result<(), Self::Error> {
        self.write_group_data(group_id, GroupDataType::GroupState, group_state)
    }

    fn group_state<
        GroupState: traits::GroupState<STORAGE_PROVIDER_VERSION>,
        GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<GroupState>, Self::Error> {
        self.read_group_data(group_id, GroupDataType::GroupState)
    }

    fn delete_group_state<GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete_group_data(group_id, GroupDataType::GroupState)
    }

    fn append_own_leaf_node<
        GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
        LeafNode: traits::LeafNode<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        leaf_node: &LeafNode,
    ) -> Result<(), Self::Error> {
        self.run(|session| {
            let key = encode(group_id)?;
            let mut nodes: LeafNodes = read_list(session, Family::MlsOwnLeafNodes, &key)?;
            nodes.push(encode(leaf_node)?);
            write_list(session, Family::MlsOwnLeafNodes, &key, &nodes)
        })
    }

    fn own_leaf_nodes<
        GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
        LeafNode: traits::LeafNode<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<LeafNode>, Self::Error> {
        self.run(|session| {
            let nodes: LeafNodes = read_list(session, Family::MlsOwnLeafNodes, &encode(group_id)?)?;
            Ok(nodes
                .iter()
                .map(|node| decode(node))
                .collect::<Result<_, _>>()?)
        })
    }

    fn delete_own_leaf_nodes<GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete_keyed(Family::MlsOwnLeafNodes, group_id)
    }

    fn queue_proposal<
        GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
        ProposalRef: traits::ProposalRef<STORAGE_PROVIDER_VERSION>,
        QueuedProposal: traits::QueuedProposal<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
        proposal: &QueuedProposal,
    ) -> Result<(), Self::Error> {
        self.run(|session| {
            let key = encode(group_id)?;
            let reference = encode(proposal_ref)?;
            let proposal = encode(proposal)?;
            let mut queue: Proposals = read_list(session, Family::MlsProposals, &key)?;
            match queue.iter_mut().find(|(queued, _)| *queued == reference) {
                Some(entry) => entry.1 = proposal,
                None => queue.push((reference, proposal)),
            }
            write_list(session, Family::MlsProposals, &key, &queue)
        })
    }

    fn queued_proposal_refs<
        GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
        ProposalRef: traits::ProposalRef<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<ProposalRef>, Self::Error> {
        self.run(|session| {
            let queue: Proposals = read_list(session, Family::MlsProposals, &encode(group_id)?)?;
            Ok(queue
                .iter()
                .map(|(reference, _)| decode(reference))
                .collect::<Result<_, _>>()?)
        })
    }

    fn queued_proposals<
        GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
        ProposalRef: traits::ProposalRef<STORAGE_PROVIDER_VERSION>,
        QueuedProposal: traits::QueuedProposal<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<(ProposalRef, QueuedProposal)>, Self::Error> {
        self.run(|session| {
            let queue: Proposals = read_list(session, Family::MlsProposals, &encode(group_id)?)?;
            let mut out = Vec::with_capacity(queue.len());
            for (reference, proposal) in &queue {
                out.push((decode(reference)?, decode(proposal)?));
            }
            Ok(out)
        })
    }

    fn remove_proposal<
        GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
        ProposalRef: traits::ProposalRef<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
    ) -> Result<(), Self::Error> {
        self.run(|session| {
            let key = encode(group_id)?;
            let reference = encode(proposal_ref)?;
            let mut queue: Proposals = read_list(session, Family::MlsProposals, &key)?;
            let before = queue.len();
            queue.retain(|(queued, _)| *queued != reference);
            if queue.len() == before {
                return Ok(());
            }
            write_list(session, Family::MlsProposals, &key, &queue)
        })
    }

    fn clear_proposal_queue<
        GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
        ProposalRef: traits::ProposalRef<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete_keyed(Family::MlsProposals, group_id)
    }

    fn write_signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<STORAGE_PROVIDER_VERSION>,
        SignatureKeyPair: traits::SignatureKeyPair<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
        signature_key_pair: &SignatureKeyPair,
    ) -> Result<(), Self::Error> {
        self.write_keyed(Family::MlsSignatureKey, public_key, signature_key_pair)
    }

    fn signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<STORAGE_PROVIDER_VERSION>,
        SignatureKeyPair: traits::SignatureKeyPair<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
    ) -> Result<Option<SignatureKeyPair>, Self::Error> {
        self.read_keyed(Family::MlsSignatureKey, public_key)
    }

    fn delete_signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
    ) -> Result<(), Self::Error> {
        self.delete_keyed(Family::MlsSignatureKey, public_key)
    }

    fn write_encryption_key_pair<
        EncryptionKey: traits::EncryptionKey<STORAGE_PROVIDER_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        public_key: &EncryptionKey,
        key_pair: &HpkeKeyPair,
    ) -> Result<(), Self::Error> {
        self.write_keyed(Family::MlsEncryptionKey, public_key, key_pair)
    }

    fn encryption_key_pair<
        HpkeKeyPair: traits::HpkeKeyPair<STORAGE_PROVIDER_VERSION>,
        EncryptionKey: traits::EncryptionKey<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        public_key: &EncryptionKey,
    ) -> Result<Option<HpkeKeyPair>, Self::Error> {
        self.read_keyed(Family::MlsEncryptionKey, public_key)
    }

    fn delete_encryption_key_pair<
        EncryptionKey: traits::EncryptionKey<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        public_key: &EncryptionKey,
    ) -> Result<(), Self::Error> {
        self.delete_keyed(Family::MlsEncryptionKey, public_key)
    }

    fn write_encryption_epoch_key_pairs<
        GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
        EpochKey: traits::EpochKey<STORAGE_PROVIDER_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
        key_pairs: &[HpkeKeyPair],
    ) -> Result<(), Self::Error> {
        self.run(|session| {
            let key = encode(group_id)?;
            let epoch = encode(epoch)?;
            let pairs = encode(&key_pairs)?;
            let mut all: EpochKeyPairs = read_list(session, Family::MlsEpochKeyPairs, &key)?;
            match all
                .iter_mut()
                .find(|(at, leaf, _)| *at == epoch && *leaf == leaf_index)
            {
                Some(entry) => entry.2 = pairs,
                None => all.push((epoch, leaf_index, pairs)),
            }
            write_list(session, Family::MlsEpochKeyPairs, &key, &all)
        })
    }

    fn encryption_epoch_key_pairs<
        GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
        EpochKey: traits::EpochKey<STORAGE_PROVIDER_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
    ) -> Result<Vec<HpkeKeyPair>, Self::Error> {
        self.run(|session| {
            let epoch = encode(epoch)?;
            let all: EpochKeyPairs =
                read_list(session, Family::MlsEpochKeyPairs, &encode(group_id)?)?;
            Ok(
                match all
                    .iter()
                    .find(|(at, leaf, _)| *at == epoch && *leaf == leaf_index)
                {
                    Some((_, _, pairs)) => decode(pairs)?,
                    None => Vec::new(),
                },
            )
        })
    }

    fn delete_encryption_epoch_key_pairs<
        GroupId: traits::GroupId<STORAGE_PROVIDER_VERSION>,
        EpochKey: traits::EpochKey<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
    ) -> Result<(), Self::Error> {
        self.run(|session| {
            let key = encode(group_id)?;
            let epoch = encode(epoch)?;
            let mut all: EpochKeyPairs = read_list(session, Family::MlsEpochKeyPairs, &key)?;
            let before = all.len();
            all.retain(|(at, leaf, _)| !(*at == epoch && *leaf == leaf_index));
            if all.len() == before {
                return Ok(());
            }
            write_list(session, Family::MlsEpochKeyPairs, &key, &all)
        })
    }

    fn write_key_package<
        HashReference: traits::HashReference<STORAGE_PROVIDER_VERSION>,
        KeyPackage: traits::KeyPackage<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        hash_ref: &HashReference,
        key_package: &KeyPackage,
    ) -> Result<(), Self::Error> {
        self.write_keyed(Family::MlsKeyPackage, hash_ref, key_package)
    }

    fn key_package<
        KeyPackageRef: traits::HashReference<STORAGE_PROVIDER_VERSION>,
        KeyPackage: traits::KeyPackage<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        hash_ref: &KeyPackageRef,
    ) -> Result<Option<KeyPackage>, Self::Error> {
        self.read_keyed(Family::MlsKeyPackage, hash_ref)
    }

    fn delete_key_package<KeyPackageRef: traits::HashReference<STORAGE_PROVIDER_VERSION>>(
        &self,
        hash_ref: &KeyPackageRef,
    ) -> Result<(), Self::Error> {
        self.delete_keyed(Family::MlsKeyPackage, hash_ref)
    }

    fn write_psk<
        PskId: traits::PskId<STORAGE_PROVIDER_VERSION>,
        PskBundle: traits::PskBundle<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        psk_id: &PskId,
        psk: &PskBundle,
    ) -> Result<(), Self::Error> {
        self.write_keyed(Family::MlsPsk, psk_id, psk)
    }

    fn psk<
        PskBundle: traits::PskBundle<STORAGE_PROVIDER_VERSION>,
        PskId: traits::PskId<STORAGE_PROVIDER_VERSION>,
    >(
        &self,
        psk_id: &PskId,
    ) -> Result<Option<PskBundle>, Self::Error> {
        self.read_keyed(Family::MlsPsk, psk_id)
    }

    fn delete_psk<PskKey: traits::PskId<STORAGE_PROVIDER_VERSION>>(
        &self,
        psk_id: &PskKey,
    ) -> Result<(), Self::Error> {
        self.delete_keyed(Family::MlsPsk, psk_id)
    }
}
