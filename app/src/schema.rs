use powersync::schema::{Column, Schema, Table};

pub fn app_schema() -> Schema {
    let mut schema = Schema::default();

    schema.tables.push(Table::create(
        "items",
        vec![
            Column::text("kind"),
            Column::text("sender_id"),
            Column::text("recipient_id"),
            Column::text("payload"),
            Column::text("created_at"),
            Column::text("expires_at"),
            Column::text("burned_at"),
            Column::text("burn_reason"),
        ],
        |_| {},
    ));

    schema.tables.push(Table::create(
        "devices",
        vec![
            Column::text("name"),
            Column::text("public_key"),
            Column::text("admission"),
            Column::text("created_at"),
            Column::text("revoked_at"),
        ],
        |_| {},
    ));

    schema
}
