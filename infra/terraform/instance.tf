# The apex host. Ubuntu 24.04 + cloud-init that installs Docker, Node 20, and the
# pinned hub CLI, then mounts the persistent volume at /mnt/townhouse. The wallet is
# NOT initialized here — an operator runs `townhouse init` once, out of band, so the
# treasury seed never lives in Terraform state or CI (see docs/deploy-linode.md).

resource "linode_instance" "hub" {
  label           = var.label
  region          = var.region
  type            = var.instance_type
  image           = "linode/ubuntu24.04"
  root_pass       = random_password.root.result
  authorized_keys = [trimspace(var.ssh_pubkey)]
  tags            = ["toon", "hub", "apex"]

  metadata {
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      ssh_pubkey   = trimspace(var.ssh_pubkey)
      hub_version  = var.hub_version
      volume_label = local.volume_label
    }))
  }
}

locals {
  volume_label = "${var.label}-data"
}
