import {
  AttendanceResult,
  AttendanceStatus,
  PunchRecord,
  WorkSchedule,
  LeaveRequest,
  OvertimeRecord,
  LeaveTypeCode,
} from '../types';
import { WorkdayChecker } from './WorkdayChecker';
import { ShiftCalculator } from './ShiftCalculator';
import {
  parseDateTime,
  timeToMinutes,
  createDateTime,
  diffMinutes,
  roundHours,
  getDatePart,
  formatDate,
} from '../utils/dateUtils';

export interface AttendanceCheckParams {
  schedule: WorkSchedule;
  punch?: PunchRecord;
  leaves: LeaveRequest[];
  overtimes: OvertimeRecord[];
}

interface LeaveTimeRange {
  startTime: string;
  endTime: string;
  leaveTypeCode: LeaveTypeCode;
  hours: number;
}

export class AttendanceChecker {
  private workdayChecker: WorkdayChecker;
  private shiftCalculator: ShiftCalculator;

  constructor(workdayChecker: WorkdayChecker, shiftCalculator: ShiftCalculator) {
    this.workdayChecker = workdayChecker;
    this.shiftCalculator = shiftCalculator;
  }

  checkAttendance(params: AttendanceCheckParams): AttendanceResult {
    const { schedule, punch, leaves, overtimes } = params;
    const date = schedule.date;
    const anomalyReasons: string[] = [];
    let status: AttendanceStatus = 'normal';
    let lateMinutes = 0;
    let earlyLeaveMinutes = 0;
    let workHours = 0;
    let overtimeHours = 0;
    let leaveHours = 0;

    if (schedule.isRestDay || schedule.isHoliday) {
      if (overtimes.length > 0) {
        status = 'overtime';
        overtimeHours = this.calculateOvertimeHours(date, overtimes);
      } else if (schedule.isHoliday) {
        status = 'rest_day';
        anomalyReasons.push(`节假日：${schedule.holidayName || '法定节假日'}`);
      } else {
        status = 'rest_day';
      }

      const isNormal = status === 'rest_day' || status === 'overtime';

      return {
        employeeId: schedule.employeeId,
        date,
        status,
        checkIn: punch?.checkIn,
        checkOut: punch?.checkOut,
        shiftStartTime: schedule.shift?.startTime,
        shiftEndTime: schedule.shift?.endTime,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        workHours: roundHours(workHours),
        overtimeHours: roundHours(overtimeHours),
        leaveHours: 0,
        nonLeaveRequiredHours: 0,
        anomalyReasons,
        isNormal,
      };
    }

    const approvedLeaves = leaves.filter(
      (l) => l.status === 'approved' || l.status === 'pending'
    );

    const businessTripLeaves = approvedLeaves.filter(
      (l) => l.leaveTypeCode === 'business_trip'
    );

    let nonLeaveRequiredHours = 0;
    let nonLeaveRangesTotal: { startTime: string; endTime: string; minutes: number }[] = [];

    if (schedule.shift) {
      const shiftHours = this.shiftCalculator.calculateShiftHours(schedule.shift);
      const leaveTimeRanges = this.getLeaveTimeRanges(date, approvedLeaves, schedule);
      leaveHours = roundHours(leaveTimeRanges.reduce((sum, r) => sum + r.hours, 0));

      const isFullDayLeave = leaveHours >= shiftHours.workHours;

      nonLeaveRangesTotal = this.calculateNonLeaveRanges(schedule.shift, date, leaveTimeRanges);
      const nonLeaveTotalMinutes = nonLeaveRangesTotal.reduce((sum, r) => sum + r.minutes, 0);
      nonLeaveRequiredHours = roundHours(nonLeaveTotalMinutes / 60);

      const workMinutesTotal = leaveHours * 60 + nonLeaveTotalMinutes;
      if (Math.abs(workMinutesTotal - shiftHours.workMinutes) > 1 && leaveHours > 0) {
        leaveHours = roundHours((shiftHours.workMinutes - nonLeaveTotalMinutes) / 60);
      }

      if (isFullDayLeave) {
        if (businessTripLeaves.length > 0) {
          status = 'business_trip';
        } else {
          status = 'leave';
        }
        leaveHours = shiftHours.workHours;
        nonLeaveRequiredHours = 0;

        return {
          employeeId: schedule.employeeId,
          date,
          status,
          checkIn: punch?.checkIn,
          checkOut: punch?.checkOut,
          shiftStartTime: schedule.shift.startTime,
          shiftEndTime: schedule.shift.endTime,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          workHours: 0,
          overtimeHours: 0,
          leaveHours: roundHours(leaveHours),
          nonLeaveRequiredHours,
          anomalyReasons: [],
          isNormal: true,
        };
      }

      if (nonLeaveRangesTotal.length > 0) {
        const requiredWorkMinutes = nonLeaveRangesTotal.reduce((sum, r) => sum + r.minutes, 0);

        if (!punch || (!punch.checkIn && !punch.checkOut)) {
          status = 'absent';
          if (leaveHours > 0) {
            anomalyReasons.push(`请假 ${leaveHours} 小时，剩余 ${roundHours(requiredWorkMinutes / 60)} 小时未打卡`);
          } else {
            anomalyReasons.push('未打卡');
          }
        } else if (!punch.checkIn || !punch.checkOut) {
          if (!punch.checkIn) {
            anomalyReasons.push('缺上班打卡');
          }
          if (!punch.checkOut) {
            anomalyReasons.push('缺下班打卡');
          }

          if (leaveHours > 0) {
            anomalyReasons.push(`请假覆盖 ${leaveHours} 小时，非请假时段打卡不完整`);
          }
          status = 'absent';
        } else {
          const lateResult = this.calculateLateMinutesForNonLeave(punch, schedule, nonLeaveRangesTotal);
          lateMinutes = lateResult.minutes;
          if (lateResult.isLate) {
            status = 'late';
            anomalyReasons.push(`非请假时段迟到 ${lateMinutes} 分钟`);
          }

          const earlyResult = this.calculateEarlyLeaveMinutesForNonLeave(punch, schedule, nonLeaveRangesTotal);
          earlyLeaveMinutes = earlyResult.minutes;
          if (earlyResult.isEarlyLeave) {
            if (status !== 'late') {
              status = 'early_leave';
            }
            anomalyReasons.push(`非请假时段早退 ${earlyLeaveMinutes} 分钟`);
          }

          if (status === 'late' || status === 'early_leave' || lateResult.isLate || earlyResult.isEarlyLeave) {
            if (leaveHours > 0) {
              anomalyReasons.push(`请假覆盖 ${leaveHours} 小时，剩余时段需正常出勤`);
            }
          }

          workHours = this.calculateActualWorkHoursFromRanges(punch, schedule, nonLeaveRangesTotal);
        }
      } else {
        if (leaveHours > 0) {
          status = 'leave';
        }
      }
    } else {
      if (approvedLeaves.length > 0) {
        leaveHours = this.calculateLeaveHours(date, approvedLeaves, schedule);
        if (leaveHours > 0) {
          const businessTripLeaves2 = approvedLeaves.filter(l => l.leaveTypeCode === 'business_trip');
          if (businessTripLeaves2.length > 0) {
            status = 'business_trip';
          } else {
            status = 'leave';
          }
        }
      }
    }

    if (!schedule.shift && !schedule.isRestDay && !schedule.isHoliday) {
      anomalyReasons.push('当日无排班');
    }

    if (schedule.shift && !punch && leaveHours === 0 && !schedule.isRestDay && !schedule.isHoliday) {
      status = 'absent';
      anomalyReasons.push('未打卡');
    }

    if (overtimes.length > 0 && schedule.shift) {
      const dayOvertime = this.calculateOvertimeHours(date, overtimes, schedule.shift);
      if (dayOvertime > 0) {
        overtimeHours = dayOvertime;
        if (status === 'normal') {
          status = 'overtime';
        }
      }
    }

    const isNormal = ['normal', 'overtime', 'leave', 'business_trip', 'rest_day'].includes(status);

    return {
      employeeId: schedule.employeeId,
      date,
      status,
      checkIn: punch?.checkIn,
      checkOut: punch?.checkOut,
      shiftStartTime: schedule.shift?.startTime,
      shiftEndTime: schedule.shift?.endTime,
      lateMinutes,
      earlyLeaveMinutes,
      workHours: roundHours(workHours),
      overtimeHours: roundHours(overtimeHours),
      leaveHours: roundHours(leaveHours),
      nonLeaveRequiredHours,
      anomalyReasons,
      isNormal,
    };
  }

  private getLeaveTimeRanges(
    date: string,
    leaves: LeaveRequest[],
    schedule: WorkSchedule
  ): LeaveTimeRange[] {
    const ranges: LeaveTimeRange[] = [];

    for (const leave of leaves) {
      const leaveStartDate = getDatePart(leave.startTime);
      const leaveEndDate = getDatePart(leave.endTime);
      if (date < leaveStartDate || date > leaveEndDate) continue;

      if (schedule.shift) {
        const deduction = this.shiftCalculator.calculateLeaveDeductionHours(
          schedule.shift,
          date,
          leave.startTime,
          leave.endTime
        );
        if (deduction.hours > 0) {
          ranges.push({
            startTime: deduction.startTime,
            endTime: deduction.endTime,
            leaveTypeCode: leave.leaveTypeCode,
            hours: deduction.hours,
          });
        }
      }
    }

    return this.mergeOverlappingRanges(ranges);
  }

  private mergeOverlappingRanges(ranges: LeaveTimeRange[]): LeaveTimeRange[] {
    if (ranges.length <= 1) return ranges;

    const sorted = [...ranges].sort((a, b) =>
      parseDateTime(a.startTime).getTime() - parseDateTime(b.startTime).getTime()
    );

    const merged: LeaveTimeRange[] = [{ ...sorted[0] }];

    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1];
      const current = sorted[i];

      if (parseDateTime(current.startTime) <= parseDateTime(last.endTime)) {
        if (parseDateTime(current.endTime) > parseDateTime(last.endTime)) {
          last.endTime = current.endTime;
        }
        last.hours = roundHours(last.hours + current.hours);
      } else {
        merged.push({ ...current });
      }
    }

    return merged;
  }

  private calculateRangeHours(range: { startTime: string; endTime: string }): number {
    return diffMinutes(range.startTime, range.endTime) / 60;
  }

  private calculateNonLeaveRanges(
    shift: NonNullable<WorkSchedule['shift']>,
    date: string,
    leaveRanges: LeaveTimeRange[]
  ): { startTime: string; endTime: string; minutes: number }[] {
    const shiftStart = createDateTime(date, shift.startTime);
    let shiftEnd = createDateTime(date, shift.endTime);
    const isNightShift = parseDateTime(shiftEnd) <= parseDateTime(shiftStart);
    if (isNightShift) {
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);
      shiftEnd = createDateTime(formatDate(nextDay), shift.endTime);
    }

    const restStart = this.createRestDateTime(date, shift.restStartTime, isNightShift);
    const restEnd = this.createRestDateTime(date, shift.restEndTime, isNightShift);

    if (leaveRanges.length === 0) {
      const shiftHours = this.shiftCalculator.calculateShiftHours(shift);
      return [{
        startTime: shiftStart,
        endTime: shiftEnd,
        minutes: shiftHours.workMinutes,
      }];
    }

    const nonLeave: { startTime: string; endTime: string; minutes: number }[] = [];
    let currentStart = shiftStart;

    const sortedLeaves = [...leaveRanges].sort((a, b) =>
      parseDateTime(a.startTime).getTime() - parseDateTime(b.startTime).getTime()
    );

    for (const leave of sortedLeaves) {
      const leaveStart = parseDateTime(leave.startTime);
      const leaveEnd = parseDateTime(leave.endTime);
      const currentStartDt = parseDateTime(currentStart);

      if (currentStartDt < leaveStart) {
        const gapStart = currentStart;
        const gapEnd = leave.startTime;
        const gapMinutes = diffMinutes(gapStart, gapEnd);

        if (restStart && restEnd) {
          const restOverlap = this.calculateOverlapMinutesGap(gapStart, gapEnd, restStart, restEnd);
          const netMinutes = Math.max(0, gapMinutes - restOverlap);
          if (netMinutes > 0) {
            nonLeave.push({ startTime: gapStart, endTime: gapEnd, minutes: netMinutes });
          }
        } else {
          if (gapMinutes > 0) {
            nonLeave.push({ startTime: gapStart, endTime: gapEnd, minutes: gapMinutes });
          }
        }
      }

      currentStart = leaveEnd > parseDateTime(currentStart) ? leave.endTime : currentStart;
    }

    const currentStartDt = parseDateTime(currentStart);
    const shiftEndDt = parseDateTime(shiftEnd);
    if (currentStartDt < shiftEndDt) {
      const gapMinutes = diffMinutes(currentStart, shiftEnd);

      if (restStart && restEnd) {
        const restOverlap = this.calculateOverlapMinutesGap(currentStart, shiftEnd, restStart, restEnd);
        const netMinutes = Math.max(0, gapMinutes - restOverlap);
        if (netMinutes > 0) {
          nonLeave.push({ startTime: currentStart, endTime: shiftEnd, minutes: netMinutes });
        }
      } else {
        if (gapMinutes > 0) {
          nonLeave.push({ startTime: currentStart, endTime: shiftEnd, minutes: gapMinutes });
        }
      }
    }

    return nonLeave;
  }

  private createRestDateTime(
    date: string,
    restTime: string | undefined,
    isNightShift: boolean
  ): string | undefined {
    if (!restTime) return undefined;
    const restDt = createDateTime(date, restTime);
    const restHour = parseDateTime(restDt).getHours();
    if (isNightShift && restHour < 12) {
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);
      return createDateTime(formatDate(nextDay), restTime);
    }
    return restDt;
  }

  private calculateOverlapMinutesGap(
    range1Start: string,
    range1End: string,
    range2Start: string,
    range2End: string
  ): number {
    const r1s = parseDateTime(range1Start).getTime();
    const r1e = parseDateTime(range1End).getTime();
    const r2s = parseDateTime(range2Start).getTime();
    const r2e = parseDateTime(range2End).getTime();

    const overlapStart = Math.max(r1s, r2s);
    const overlapEnd = Math.min(r1e, r2e);

    if (overlapStart >= overlapEnd) return 0;
    return Math.round((overlapEnd - overlapStart) / (1000 * 60));
  }

  private calculateLateMinutesForNonLeave(
    punch: PunchRecord,
    schedule: WorkSchedule,
    nonLeaveRanges: { startTime: string; endTime: string; minutes: number }[]
  ): { minutes: number; isLate: boolean } {
    if (!punch.checkIn || !schedule.shift || nonLeaveRanges.length === 0) {
      return { minutes: 0, isLate: false };
    }

    const firstNonLeave = nonLeaveRanges[0];
    const graceMinutes = schedule.shift.lateGraceMinutes || 0;
    const checkInTime = this.createPunchDateTime(schedule, punch.checkIn);
    const requiredStart = parseDateTime(firstNonLeave.startTime);

    let diff = (checkInTime.getTime() - requiredStart.getTime()) / (1000 * 60);
    if (diff < 0) diff = 0;

    const isLate = diff > graceMinutes;
    const actualMinutes = isLate ? Math.round(diff - graceMinutes) : 0;

    return { minutes: actualMinutes, isLate };
  }

  private calculateEarlyLeaveMinutesForNonLeave(
    punch: PunchRecord,
    schedule: WorkSchedule,
    nonLeaveRanges: { startTime: string; endTime: string; minutes: number }[]
  ): { minutes: number; isEarlyLeave: boolean } {
    if (!punch.checkOut || !schedule.shift || nonLeaveRanges.length === 0) {
      return { minutes: 0, isEarlyLeave: false };
    }

    const lastNonLeave = nonLeaveRanges[nonLeaveRanges.length - 1];
    const graceMinutes = schedule.shift.earlyLeaveGraceMinutes || 0;
    const checkOutTime = this.createPunchDateTime(schedule, punch.checkOut);
    const requiredEnd = parseDateTime(lastNonLeave.endTime);

    let diff = (requiredEnd.getTime() - checkOutTime.getTime()) / (1000 * 60);
    if (diff < 0) diff = 0;

    const isEarlyLeave = diff > graceMinutes;
    const actualMinutes = isEarlyLeave ? Math.round(diff - graceMinutes) : 0;

    return { minutes: actualMinutes, isEarlyLeave };
  }

  private createPunchDateTime(schedule: WorkSchedule, punchTime: string): Date {
    if (!schedule.shift) return parseDateTime(createDateTime(schedule.date, punchTime));

    const shiftStartMinutes = timeToMinutes(schedule.shift.startTime);
    const shiftEndMinutes = timeToMinutes(schedule.shift.endTime);
    const punchMinutes = timeToMinutes(punchTime);
    const isNightShift = shiftEndMinutes <= shiftStartMinutes;

    if (isNightShift && punchMinutes < shiftStartMinutes) {
      const nextDay = new Date(schedule.date);
      nextDay.setDate(nextDay.getDate() + 1);
      return parseDateTime(createDateTime(formatDate(nextDay), punchTime));
    }

    return parseDateTime(createDateTime(schedule.date, punchTime));
  }

  private calculateActualWorkHoursExcludingLeave(
    punch: PunchRecord,
    schedule: WorkSchedule,
    leaveTimeRanges: LeaveTimeRange[],
    date: string
  ): number {
    if (!punch.checkIn || !punch.checkOut || !schedule.shift) {
      return 0;
    }

    const nonLeaveRanges = this.calculateNonLeaveRanges(schedule.shift, date, leaveTimeRanges);
    return this.calculateActualWorkHoursFromRanges(punch, schedule, nonLeaveRanges);
  }

  private calculateActualWorkHoursFromRanges(
    punch: PunchRecord,
    schedule: WorkSchedule,
    nonLeaveRanges: { startTime: string; endTime: string; minutes: number }[]
  ): number {
    if (!punch.checkIn || !punch.checkOut || !schedule.shift) {
      return 0;
    }

    const shiftHours = this.shiftCalculator.calculateShiftHours(schedule.shift);
    const punchStartDt = this.createPunchDateTime(schedule, punch.checkIn);
    let punchEndDt = this.createPunchDateTime(schedule, punch.checkOut);

    if (punchEndDt <= punchStartDt) {
      punchEndDt = new Date(punchEndDt.getTime() + 24 * 60 * 60 * 1000);
    }

    let totalWorkMinutes = 0;

    for (const range of nonLeaveRanges) {
      const rangeStart = parseDateTime(range.startTime);
      const rangeEnd = parseDateTime(range.endTime);

      const actualStart = punchStartDt > rangeStart ? punchStartDt : rangeStart;
      const actualEnd = punchEndDt < rangeEnd ? punchEndDt : rangeEnd;

      if (actualEnd > actualStart) {
        totalWorkMinutes += (actualEnd.getTime() - actualStart.getTime()) / (1000 * 60);
      }
    }

    return Math.min(roundHours(totalWorkMinutes / 60), shiftHours.workHours);
  }

  private calculateLateMinutes(
    punch: PunchRecord,
    schedule: WorkSchedule
  ): { minutes: number; isLate: boolean } {
    if (!punch.checkIn || !schedule.shift) {
      return { minutes: 0, isLate: false };
    }

    const graceMinutes = schedule.shift.lateGraceMinutes || 0;
    const checkInMinutes = timeToMinutes(punch.checkIn);
    const shiftStartMinutes = timeToMinutes(schedule.shift.startTime);

    let diff = checkInMinutes - shiftStartMinutes;
    if (diff < 0) diff = 0;

    const isLate = diff > graceMinutes;
    const actualMinutes = isLate ? diff - graceMinutes : 0;

    return { minutes: actualMinutes, isLate };
  }

  private calculateEarlyLeaveMinutes(
    punch: PunchRecord,
    schedule: WorkSchedule
  ): { minutes: number; isEarlyLeave: boolean } {
    if (!punch.checkOut || !schedule.shift) {
      return { minutes: 0, isEarlyLeave: false };
    }

    const graceMinutes = schedule.shift.earlyLeaveGraceMinutes || 0;
    const checkOutMinutes = timeToMinutes(punch.checkOut);
    let shiftEndMinutes = timeToMinutes(schedule.shift.endTime);

    if (shiftEndMinutes <= timeToMinutes(schedule.shift.startTime)) {
      shiftEndMinutes += 24 * 60;
    }

    let actualCheckOut = checkOutMinutes;
    if (shiftEndMinutes > 24 * 60 && checkOutMinutes <= timeToMinutes(schedule.shift.startTime)) {
      actualCheckOut = checkOutMinutes + 24 * 60;
    }

    let diff = shiftEndMinutes - actualCheckOut;
    if (diff < 0) diff = 0;

    const isEarlyLeave = diff > graceMinutes;
    const actualMinutes = isEarlyLeave ? diff - graceMinutes : 0;

    return { minutes: actualMinutes, isEarlyLeave };
  }

  private calculateLeaveHours(
    date: string,
    leaves: LeaveRequest[],
    schedule: WorkSchedule
  ): number {
    let totalHours = 0;

    for (const leave of leaves) {
      const leaveStartDate = getDatePart(leave.startTime);
      const leaveEndDate = getDatePart(leave.endTime);

      if (date < leaveStartDate || date > leaveEndDate) continue;

      if (schedule.shift) {
        const deduction = this.shiftCalculator.calculateLeaveDeductionHours(
          schedule.shift,
          date,
          leave.startTime,
          leave.endTime
        );
        totalHours += deduction.hours;
      } else {
        const leaveStart = parseDateTime(leave.startTime);
        const leaveEnd = parseDateTime(leave.endTime);
        const dayStart = parseDateTime(createDateTime(date, '00:00'));
        const dayEnd = parseDateTime(createDateTime(date, '23:59:59'));

        const actualStart = leaveStart > dayStart ? leaveStart : dayStart;
        const actualEnd = leaveEnd < dayEnd ? leaveEnd : dayEnd;

        if (actualEnd > actualStart) {
          totalHours += diffMinutes(
            formatDate(actualStart) + ' ' + actualStart.toTimeString().slice(0, 8),
            formatDate(actualEnd) + ' ' + actualEnd.toTimeString().slice(0, 8)
          ) / 60;
        }
      }
    }

    return totalHours;
  }

  private calculateOvertimeHours(
    date: string,
    overtimes: OvertimeRecord[],
    shift?: WorkSchedule['shift']
  ): number {
    let totalHours = 0;

    for (const ot of overtimes) {
      if (ot.date !== date || !ot.approved) continue;

      if (shift) {
        const shiftEnd = timeToMinutes(shift.endTime);
        const otStart = timeToMinutes(ot.startTime);
        const otEnd = timeToMinutes(ot.endTime);

        let actualStart = otStart > shiftEnd ? otStart : shiftEnd;
        let actualEnd = otEnd;

        if (actualEnd > actualStart) {
          totalHours += (actualEnd - actualStart) / 60;
        }
      } else {
        totalHours += ot.durationHours;
      }
    }

    return totalHours;
  }
}
