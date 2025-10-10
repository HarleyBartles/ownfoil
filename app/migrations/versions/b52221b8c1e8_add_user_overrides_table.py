"""bridge: lost revision b52221b8c1e8

This is a no-op placeholder so Alembic can locate the missing revision id.
It intentionally does nothing.
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "b52221b8c1e8"
down_revision = '78c33e9bffce'
branch_labels = None
depends_on = None

def upgrade():
    op.create_table(
        'user_overrides',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('title_id', sa.String(), nullable=True),
        sa.Column('file_basename', sa.String(), nullable=True),
        sa.Column('app_id', sa.String(), nullable=True),
        sa.Column('app_version', sa.String(), nullable=True),
        sa.Column('name', sa.String(length=512), nullable=True),
        sa.Column('publisher', sa.String(length=256), nullable=True),
        sa.Column('region', sa.String(length=32), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('content_type', sa.String(length=64), nullable=True),
        sa.Column('version', sa.String(length=64), nullable=True),
        sa.Column('icon_path', sa.String(length=1024), nullable=True),
        sa.Column('banner_path', sa.String(length=1024), nullable=True),
        sa.Column('enabled', sa.Boolean(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_user_overrides_title_id', 'user_overrides', ['title_id'])
    op.create_index('ix_user_overrides_file_basename', 'user_overrides', ['file_basename'])
    op.create_index('ix_user_overrides_app_id', 'user_overrides', ['app_id'])
    op.create_index('ix_user_overrides_app_version', 'user_overrides', ['app_version'])

def downgrade():
    op.drop_index('ix_user_overrides_app_version', table_name='user_overrides')
    op.drop_index('ix_user_overrides_app_id', table_name='user_overrides')
    op.drop_index('ix_user_overrides_file_basename', table_name='user_overrides')
    op.drop_index('ix_user_overrides_title_id', table_name='user_overrides')
    op.drop_table('user_overrides')
