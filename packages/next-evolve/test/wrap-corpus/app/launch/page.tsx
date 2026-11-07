import { AnnouncementBar } from "../../components/announcement-bar";
import { Countdown } from "../../components/countdown";
import { CtaBanner } from "../../components/cta-banner";

const LAUNCH = new Date("2027-01-15T09:00:00Z");

export default function LaunchPage() {
  return (
    <>
      <AnnouncementBar variant="promo" dismissible>
        Launch week: 30% off annual plans
      </AnnouncementBar>
      <CtaBanner
        message="Join the launch webinar on Thursday"
        buttonText="Save my seat"
        href="/webinar"
        tone="success"
      />
      <Countdown label="Offer ends" endsAt={LAUNCH} urgent />
    </>
  );
}
