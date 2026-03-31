variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "aws_profile" {
  type    = string
  default = "my-aws-project"
}

variable "instance_type" {
  type    = string
  default = "t3.micro"
}

variable "key_name" {
  type = string
}

variable "allowed_ssh_cidr" {
  type    = string
  default = "0.0.0.0/0"
}

variable "allowed_app_cidr" {
  type    = string
  default = "0.0.0.0/0"
}

variable "associate_public_ip" {
  type    = bool
  default = true
}

variable "app_repo_url" {
  type    = string
  default = "https://github.com/bigb787/Infodesk_leavers.git"
}

variable "app_repo_branch" {
  type    = string
  default = "main"
}

variable "app_port" {
  type    = number
  default = 3000
}

variable "backup_bucket_name" {
  type    = string
  default = null
}

variable "backup_schedule_cron" {
  type    = string
  default = "0 2 * * *"
}

variable "backup_retention_days" {
  type    = number
  default = 30
}
