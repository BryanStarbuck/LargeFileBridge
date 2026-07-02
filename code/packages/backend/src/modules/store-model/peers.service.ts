// peers.yaml accessor (storage.mdx §11).
import { PeersSchema, type Peers, type PeerRow } from "@lfb/shared";
import { readYaml } from "../../shared/store/yaml-store.js";
import { peersPath } from "../../shared/store/scopes.js";

export function getPeers(): Peers {
  return readYaml(peersPath(), PeersSchema);
}

export function peerRows(): PeerRow[] {
  return getPeers().peers.map((p) => ({
    id: p.id,
    label: p.label,
    ipfsPeerId: p.ipfs_peer_id,
    owner: p.owner,
    lastSeen: p.last_seen,
  }));
}
