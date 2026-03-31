data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_ami" "ubuntu_noble" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "aws_caller_identity" "current" {}

locals {
  project_name  = "infodesk-leavers"
  backup_bucket = coalesce(var.backup_bucket_name, "infodesk-leavers-backups-${data.aws_caller_identity.current.account_id}-${var.aws_region}")

  user_data = <<-EOF
#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

APP_DIR="/opt/infodesk-leavers"
REPO_URL="${var.app_repo_url}"
REPO_BRANCH="${var.app_repo_branch}"
APP_PORT="${var.app_port}"
BACKUP_BUCKET="${local.backup_bucket}"
APP_URL="http://$(curl -fsSL http://169.254.169.254/latest/meta-data/public-ipv4 || echo 127.0.0.1)"

apt-get update
apt-get install -y ca-certificates curl gnupg git nginx build-essential python3 sqlite3 gzip unzip
systemctl restart amazon-ssm-agent || true

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
npm install -g pm2

curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
unzip -o /tmp/awscliv2.zip -d /tmp
/tmp/aws/install --update

rm -rf "$APP_DIR"
git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR" || git clone --depth 1 "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"
npm install --omit=dev || npm install
mkdir -p uploads/evidence data
pm2 delete infodesk-leavers || true
PORT="$APP_PORT" AWS_REGION="${var.aws_region}" BACKUP_BUCKET="$BACKUP_BUCKET" EVIDENCE_BUCKET="$BACKUP_BUCKET" APP_BASE_URL="$APP_URL" pm2 start npm --name infodesk-leavers -- start
pm2 save
env PATH="$PATH:/usr/bin" pm2 startup systemd -u root --hp /root || true

cat > /etc/nginx/sites-available/infodesk-leavers <<NGINX
server {
  listen 80 default_server;
  server_name _;

  client_max_body_size 25m;

  location / {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_cache_bypass \$http_upgrade;
  }
}
NGINX

ln -sf /etc/nginx/sites-available/infodesk-leavers /etc/nginx/sites-enabled/infodesk-leavers
rm -f /etc/nginx/sites-enabled/default || true
systemctl enable nginx
systemctl restart nginx

cat > /usr/local/bin/backup-infodesk-leavers-db.sh <<BKP
#!/bin/bash
set -euo pipefail
DB_PATH="/opt/infodesk-leavers/data/infodesk_leavers.sqlite"
TMP_DIR="/tmp/infodesk-leavers-backup"
STAMP="\$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "\$TMP_DIR"
if [ ! -f "\$DB_PATH" ]; then
  echo "Database file not found: \$DB_PATH"
  exit 1
fi
sqlite3 "\$DB_PATH" ".backup '\$TMP_DIR/infodesk_leavers_$${STAMP}.sqlite'"
gzip -f "\$TMP_DIR/infodesk_leavers_$${STAMP}.sqlite"
aws s3 cp "\$TMP_DIR/infodesk_leavers_$${STAMP}.sqlite.gz" "s3://$BACKUP_BUCKET/sqlite/infodesk_leavers_$${STAMP}.sqlite.gz"
rm -f "\$TMP_DIR"/infodesk_leavers_*.sqlite.gz
BKP

chmod +x /usr/local/bin/backup-infodesk-leavers-db.sh
echo "${var.backup_schedule_cron} root /usr/local/bin/backup-infodesk-leavers-db.sh >> /var/log/infodesk-leavers-backup.log 2>&1" > /etc/cron.d/infodesk-leavers-backup
chmod 644 /etc/cron.d/infodesk-leavers-backup
systemctl restart cron || service cron restart || true
EOF
}

resource "aws_security_group" "app" {
  name        = "infodesk-leavers-app-sg"
  description = "SSH, HTTP, and app port access"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.allowed_app_cidr]
  }

  ingress {
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = [var.allowed_app_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "infodesk-leavers-app-sg"
    Project = local.project_name
  }
}

resource "aws_iam_role" "ec2_ssm_role" {
  name = "infodesk-leavers-ec2-ssm-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ec2_ssm_core" {
  role       = aws_iam_role.ec2_ssm_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "ec2_backup_s3_policy" {
  name = "infodesk-leavers-ec2-backup-s3-policy"
  role = aws_iam_role.ec2_ssm_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:AbortMultipartUpload", "s3:GetObject"]
        Resource = [
          "arn:aws:s3:::${local.backup_bucket}/sqlite/*",
          "arn:aws:s3:::${local.backup_bucket}/evidence/*"
        ]
      },
      {
        Effect = "Allow"
        Action = ["s3:ListBucket"]
        Resource = "arn:aws:s3:::${local.backup_bucket}"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "ec2_ssm_profile" {
  name = "infodesk-leavers-ec2-ssm-profile"
  role = aws_iam_role.ec2_ssm_role.name
}

resource "aws_s3_bucket" "backup" {
  bucket = local.backup_bucket

  tags = {
    Name    = local.backup_bucket
    Project = local.project_name
    Purpose = "db-backup"
  }
}

resource "aws_s3_bucket_public_access_block" "backup" {
  bucket = aws_s3_bucket.backup.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    id     = "expire-old-backups"
    status = "Enabled"

    filter {
      prefix = "sqlite/"
    }

    expiration {
      days = var.backup_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.backup_retention_days
    }
  }
}

resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu_noble.id
  instance_type               = var.instance_type
  key_name                    = var.key_name
  subnet_id                   = sort(data.aws_subnets.default.ids)[0]
  vpc_security_group_ids      = [aws_security_group.app.id]
  associate_public_ip_address = var.associate_public_ip
  iam_instance_profile        = aws_iam_instance_profile.ec2_ssm_profile.name
  user_data                   = local.user_data

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = {
    Name    = "infodesk-leavers-ubuntu"
    Project = local.project_name
  }
}
