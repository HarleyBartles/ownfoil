from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "c6acf1de9ab3"
down_revision = "b52221b8c1e8"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("app_overrides") as batch_op:
        batch_op.add_column(
            sa.Column(
                "suppress_missing",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            )
        )
        batch_op.drop_column("version")

    # Drop the server default now that existing rows are initialized.
    op.alter_column(
        "app_overrides",
        "suppress_missing",
        existing_type=sa.Boolean(),
        server_default=None,
    )


def downgrade():
    with op.batch_alter_table("app_overrides") as batch_op:
        batch_op.add_column(sa.Column("version", sa.String(length=64), nullable=True))
        batch_op.drop_column("suppress_missing")
