from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "c6acf1de9ab3"
down_revision = "b52221b8c1e8"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "app_overrides",
        sa.Column(
            "suppress_missing",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )

    op.execute(sa.text("UPDATE app_overrides SET suppress_missing = 0 WHERE suppress_missing IS NULL"))

    op.alter_column(
        "app_overrides",
        "suppress_missing",
        server_default=None,
        existing_type=sa.Boolean(),
        existing_nullable=False,
    )

    op.drop_column("app_overrides", "version")


def downgrade():
    op.add_column(
        "app_overrides",
        sa.Column("version", sa.String(length=64), nullable=True),
    )
    op.drop_column("app_overrides", "suppress_missing")
