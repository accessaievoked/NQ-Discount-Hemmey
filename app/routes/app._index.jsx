import { useMemo, useState } from "react";
import { useLoaderData, useNavigate, useRevalidator, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// ---------------------------------------------------------------------------
// App home page: lists every synced "product_offer" metaobject (one per
// discount that has been synced by the app) as a searchable/filterable
// table. Clicking a row opens the detail page for that offer.
// ---------------------------------------------------------------------------
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let offers = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `query getOffers($cursor: String) {
        metaobjects(type: "$app:product_offer", first: 50, after: $cursor) {
          nodes {
            id
            fields { key value }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { cursor } }
    );
    const json = await response.json();
    const conn = json.data.metaobjects;
    offers.push(...conn.nodes);
    hasNextPage = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }

  const parsed = offers.map((node) => {
    const get = (key) => node.fields.find((f) => f.key === key)?.value || "";

    let linkedProductIds = [];
    try {
      linkedProductIds = JSON.parse(get("linked_product_ids") || "[]");
    } catch {
      linkedProductIds = [];
    }

    const discountGid = get("discount_gid");

    return {
      id: node.id,
      title: get("title"),
      description: get("description"),
      descriptionOverride: get("description_override") === "true",
      approved: get("approved") === "true",
      code: get("code"),
      startsAt: get("starts_at"),
      endsAt: get("ends_at"),
      type: discountGid.includes("DiscountCode")
        ? "Discount code"
        : "Automatic discount",
      productCount: linkedProductIds.length,
    };
  });

  return {
    offers: parsed,
    shopName: session.shop.replace(".myshopify.com", ""),
  };
};

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function downloadCsv(rows) {
  const header = [
    "Title",
    "Type",
    "Code",
    "Applies to",
    "Description",
    "Starts",
    "Ends",
  ];
  const lines = [header.join(",")];
  rows.forEach((o) => {
    const cells = [
      o.title,
      o.type,
      o.code,
      `${o.productCount} products`,
      o.description,
      formatDate(o.startsAt),
      o.endsAt ? formatDate(o.endsAt) : "No end date",
    ].map((c) => `"${String(c || "").replace(/"/g, '""')}"`);
    lines.push(cells.join(","));
  });
  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "offers.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// A row's Approve / Unapprove control. Its own component so each row gets
// its own fetcher instance (hooks can't be called inside a .map callback).
function ApprovalToggle({ offer, onSettled }) {
  const fetcher = useFetcher();
  const isBusy = fetcher.state !== "idle";

  // Optimistic: while a submission is in flight, trust what we just sent
  // instead of the possibly-stale loader value.
  const pendingApproved =
    fetcher.formData?.get("approved") != null
      ? fetcher.formData.get("approved") === "true"
      : offer.approved;

  const submit = (nextApproved) => {
    fetcher.submit(
      { approved: nextApproved ? "true" : "false" },
      {
        method: "post",
        action: `/app/offers/${encodeURIComponent(offer.id)}/approve`,
      }
    );
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: ".5rem" }}>
      <span
        className={`offers-dash-badge ${
          pendingApproved ? "is-automatic" : "is-pending"
        }`}
      >
        {pendingApproved ? "Approved" : "Pending"}
      </span>
      <button
        type="button"
        className="offers-dash-btn"
        disabled={isBusy}
        onClick={(e) => {
          e.stopPropagation();
          submit(!pendingApproved);
        }}
      >
        {pendingApproved ? "Unapprove" : "Approve"}
      </button>
    </div>
  );
}

export default function Offers() {
  const { offers: loadedOffers, shopName } = useLoaderData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const offers = loadedOffers;
  const pendingCount = offers.filter((o) => !o.approved).length;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return offers.filter((o) => {
      const matchesType = typeFilter === "all" || o.type === typeFilter;
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "approved" && o.approved) ||
        (statusFilter === "pending" && !o.approved);
      const matchesSearch =
        term === "" ||
        o.title.toLowerCase().includes(term) ||
        o.code.toLowerCase().includes(term);
      return matchesType && matchesStatus && matchesSearch;
    });
  }, [offers, search, typeFilter, statusFilter]);

  return (
    <s-page heading="Offers">
      <style>{`
        .offers-dash-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 1rem;
          margin-bottom: 1.25rem;
          flex-wrap: wrap;
        }
        .offers-dash-title {
          font-size: 1.5rem;
          font-weight: 700;
          color: #1a1a1a;
          margin: 0;
        }
        .offers-dash-subtitle {
          font-size: .8125rem;
          color: #6b6b6b;
          margin-top: .25rem;
        }
        .offers-dash-actions {
          display: flex;
          gap: .5rem;
        }
        .offers-dash-btn {
          border-radius: 8px;
          padding: .5rem 1rem;
          font-size: .8125rem;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid #d3d3d3;
          background: #fff;
          color: #1a1a1a;
        }
        .offers-dash-btn.is-primary {
          background: #1a1a1a;
          color: #fff;
          border-color: #1a1a1a;
        }
        .offers-dash-card {
          background: #fff;
          border: 1px solid #e3e3e3;
          border-radius: 10px;
          padding: 1.25rem 1.5rem;
          margin-bottom: 1rem;
        }
        .offers-dash-stat-number {
          font-size: 2rem;
          font-weight: 700;
          color: #1a1a1a;
          line-height: 1;
        }
        .offers-dash-stat-label {
          margin-top: .375rem;
          font-size: .75rem;
          letter-spacing: .04em;
          text-transform: uppercase;
          color: #8a8a8a;
        }
        .offers-dash-filters {
          display: flex;
          align-items: center;
          gap: .75rem;
          flex-wrap: wrap;
        }
        .offers-dash-filters label {
          font-size: .6875rem;
          font-weight: 700;
          letter-spacing: .04em;
          text-transform: uppercase;
          color: #8a8a8a;
        }
        .offers-dash-select,
        .offers-dash-search {
          border: 1px solid #d3d3d3;
          border-radius: 8px;
          padding: .5rem .625rem;
          font-size: .8125rem;
          color: #1a1a1a;
        }
        .offers-dash-search {
          flex: 1;
          min-width: 200px;
        }
        .offers-dash-count {
          margin-left: auto;
          font-size: .75rem;
          color: #8a8a8a;
          background: #f2f2f2;
          padding: .25rem .625rem;
          border-radius: 999px;
        }
        .offers-dash-table {
          width: 100%;
          border-collapse: collapse;
          font-size: .8125rem;
        }
        .offers-dash-table thead th {
          text-align: left;
          font-size: .6875rem;
          letter-spacing: .04em;
          text-transform: uppercase;
          color: #8a8a8a;
          font-weight: 700;
          padding: .625rem .75rem;
          background: #fafafa;
          border-bottom: 1px solid #e3e3e3;
        }
        .offers-dash-table tbody td {
          padding: .75rem;
          border-bottom: 1px solid #efefef;
          color: #1a1a1a;
          vertical-align: middle;
        }
        .offers-dash-table tbody tr {
          cursor: pointer;
        }
        .offers-dash-table tbody tr:hover {
          background: #fafafa;
        }
        .offers-dash-row-index {
          color: #8a8a8a;
        }
        .offers-dash-title-link {
          color: #2c6ecb;
          font-weight: 600;
        }
        .offers-dash-badge {
          display: inline-block;
          padding: .1875rem .5rem;
          border-radius: 999px;
          font-size: .6875rem;
          font-weight: 600;
          white-space: nowrap;
        }
        .offers-dash-badge.is-automatic {
          background: #e3f5e9;
          color: #1e7a43;
        }
        .offers-dash-badge.is-code {
          background: #e5f0ff;
          color: #1655b3;
        }
        .offers-dash-badge.is-pending {
          background: #fff0e0;
          color: #a15c00;
        }
        .offers-dash-empty {
          padding: 2rem;
          text-align: center;
          color: #8a8a8a;
          font-size: .875rem;
        }
        .offers-dash-edited-badge {
          margin-left: .375rem;
          display: inline-block;
          padding: .0625rem .5rem;
          border-radius: 999px;
          font-size: .625rem;
          font-weight: 700;
          background: #fff4d9;
          color: #8a5a00;
        }
      `}</style>

      <div className="offers-dash-header">
        <div>
          <p className="offers-dash-title">Offers Dashboard</p>
          <p className="offers-dash-subtitle">
            {shopName} · {offers.length}{" "}
            {offers.length === 1 ? "entry" : "entries"}
          </p>
        </div>
        <div className="offers-dash-actions">
          <button
            type="button"
            className="offers-dash-btn"
            onClick={() => downloadCsv(filtered)}
          >
            ↓ Export CSV
          </button>
          <button
            type="button"
            className="offers-dash-btn is-primary"
            onClick={() => revalidator.revalidate()}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <div className="offers-dash-card" style={{ flex: 1, minWidth: 160 }}>
          <div className="offers-dash-stat-number">{offers.length}</div>
          <div className="offers-dash-stat-label">
            {offers
              .map((o) => o.title)
              .filter(Boolean)
              .slice(0, 3)
              .join(" · ") || "No offers yet"}
          </div>
        </div>
        <div className="offers-dash-card" style={{ flex: 1, minWidth: 160 }}>
          <div className="offers-dash-stat-number">{pendingCount}</div>
          <div className="offers-dash-stat-label">
            Waiting for approval — hidden from the cart until reviewed
          </div>
        </div>
      </div>

      <div className="offers-dash-card">
        <div className="offers-dash-filters">
          <label htmlFor="offers-status-filter">Status</label>
          <select
            id="offers-status-filter"
            className="offers-dash-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="approved">Approved (on cart)</option>
            <option value="pending">Pending (hidden)</option>
          </select>
          <label htmlFor="offers-type-filter">Type</label>
          <select
            id="offers-type-filter"
            className="offers-dash-select"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="all">All types</option>
            <option value="Discount code">Discount code</option>
            <option value="Automatic discount">Automatic discount</option>
          </select>
          <input
            type="text"
            className="offers-dash-search"
            placeholder="Search title, code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="offers-dash-count">{filtered.length} results</span>
        </div>
      </div>

      <div className="offers-dash-card" style={{ padding: 0, overflow: "hidden" }}>
        {filtered.length === 0 ? (
          <div className="offers-dash-empty">
            {offers.length === 0
              ? "No offers yet. Create a discount targeting specific products or a collection in Shopify, and it will appear here — pending your approval — automatically."
              : "No offers match your search."}
          </div>
        ) : (
          <table className="offers-dash-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Title</th>
                <th>Type</th>
                <th>On cart?</th>
                <th>Code</th>
                <th>Applies to</th>
                <th>Description</th>
                <th>Starts</th>
                <th>Ends</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((offer, i) => (
                <tr
                  key={offer.id}
                  onClick={() =>
                    navigate(`/app/offers/${encodeURIComponent(offer.id)}`)
                  }
                >
                  <td className="offers-dash-row-index">{i + 1}</td>
                  <td>
                    <span className="offers-dash-title-link">
                      {offer.title || "Untitled"}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`offers-dash-badge ${
                        offer.type === "Discount code"
                          ? "is-code"
                          : "is-automatic"
                      }`}
                    >
                      {offer.type}
                    </span>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <ApprovalToggle offer={offer} />
                  </td>
                  <td>{offer.code || "—"}</td>
                  <td>
                    {offer.productCount} product
                    {offer.productCount === 1 ? "" : "s"}
                  </td>
                  <td>
                    {offer.description || "—"}
                    {offer.descriptionOverride && (
                      <span className="offers-dash-edited-badge">Edited</span>
                    )}
                  </td>
                  <td>{formatDate(offer.startsAt)}</td>
                  <td>{offer.endsAt ? formatDate(offer.endsAt) : "No end date"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};