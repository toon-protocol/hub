output "instance_ip" {
  description = "Public IPv4 of the apex host. Consumed by the deploy workflow for SSH."
  value       = linode_instance.hub.ip_address
}

output "instance_id" {
  description = "Linode instance id."
  value       = linode_instance.hub.id
}

output "volume_id" {
  description = "Block Storage volume id (the durable wallet/.anon root — snapshot before destroy)."
  value       = linode_volume.hub_data.id
}

output "transport" {
  description = "Active transport the firewall was provisioned for."
  value       = var.transport
}
