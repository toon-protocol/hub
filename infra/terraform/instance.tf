# The apex host. Ubuntu 24.04 + cloud-init that installs Docker, Node 20, and the pinned
# hub CLI, mounts the persistent volume at /mnt/hub, then initializes (mnemonic
# mode) and starts the apex via a systemd unit — entirely at first boot, no SSH. There
# is no authorized_keys: the box is config-driven and observed via the status push.

resource "linode_instance" "hub" {
  label     = var.label
  region    = var.region
  type      = var.instance_type
  image     = "linode/ubuntu24.04"
  root_pass = random_password.root.result
  tags      = ["toon", "hub", "apex"]

  metadata {
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      hub_version       = var.hub_version
      volume_label      = local.volume_label
      network           = var.network
      status_bucket     = var.status_bucket
      status_endpoint   = var.status_endpoint
      status_access_key = var.status_access_key
      status_secret_key = var.status_secret_key
      debug_ssh_pubkey  = var.debug_ssh_pubkey
    }))
  }
}

locals {
  volume_label = "${var.label}-data"
}
